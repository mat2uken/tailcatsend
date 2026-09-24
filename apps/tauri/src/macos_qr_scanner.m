#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>
#import <Vision/Vision.h>
#import <dlfcn.h>
#import <stdint.h>

typedef void (*PonletScanCompletion)(void *context, const char *value, const char *error);
typedef void (*PonletPreviewFrame)(void *context, uint64_t scanID, const char *image);

@interface PonletQrScanner : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@property(nonatomic) uint64_t scanID;
@property(nonatomic) void *context;
@property(nonatomic) PonletScanCompletion completion;
@property(nonatomic) PonletPreviewFrame previewFrame;
@property(nonatomic, strong) AVCaptureSession *session;
@property(nonatomic, strong) AVCaptureVideoDataOutput *videoOutput;
@property(nonatomic, strong) dispatch_queue_t cameraQueue;
@property(nonatomic, strong) dispatch_queue_t frameQueue;
@property(nonatomic, strong) CIContext *imageContext;
@property(nonatomic) CFTimeInterval lastFrameTime;
@property(nonatomic) NSUInteger detectionFailures;
@property(nonatomic, copy) NSString *startupStage;
@property(atomic) BOOL stopped;
- (void)start;
- (void)finishWithValue:(NSString *)value error:(NSString *)error;
@end

static PonletQrScanner *activeScanner;
static NSMutableSet<NSNumber *> *cancelledIDs;

static dispatch_queue_t PonletCameraQueue(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("jp.yasagure.ponlet.camera", DISPATCH_QUEUE_SERIAL);
    });
    return queue;
}

@implementation PonletQrScanner
- (void)timeoutAfter:(NSTimeInterval)seconds stage:(NSString *)stage {
    self.startupStage = stage;
    uint64_t scanID = self.scanID;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)),
        dispatch_get_main_queue(), ^{
            if (activeScanner == self && !self.stopped && [self.startupStage isEqualToString:stage]) {
                NSLog(@"Ponlet QR scan %llu: timed out during %@", scanID, stage);
                [self finishWithValue:nil error:[NSString stringWithFormat:@"Camera %@ timed out", stage]];
            }
        });
}

- (void)start {
    AVAuthorizationStatus permission = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    NSLog(@"Ponlet QR scan %llu: camera authorization %ld", self.scanID, (long)permission);
    if (permission == AVAuthorizationStatusNotDetermined) {
        [self timeoutAfter:30 stage:@"permission request"];
        __weak PonletQrScanner *weakSelf = self;
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
            dispatch_async(dispatch_get_main_queue(), ^{
                PonletQrScanner *scanner = weakSelf;
                if (!scanner || scanner.stopped) return;
                NSLog(@"Ponlet QR scan %llu: permission response %d", scanner.scanID, granted);
                if (granted) [scanner openCamera];
                else [scanner finishWithValue:nil error:@"Camera permission is required to scan a QR code"];
            });
        }];
    } else if (permission == AVAuthorizationStatusAuthorized) {
        [self openCamera];
    } else {
        [self finishWithValue:nil error:@"Camera permission is required to scan a QR code"];
    }
}

- (void)openCamera {
    if (self.stopped) return;
    [self timeoutAfter:15 stage:@"initialization"];
    // A previous scan may still be stopping; serialize camera work across scans.
    self.cameraQueue = PonletCameraQueue();
    self.frameQueue = dispatch_queue_create("jp.yasagure.ponlet.camera.frames", DISPATCH_QUEUE_SERIAL);
    dispatch_async(self.cameraQueue, ^{
        // Resolve Vision dynamically so the scanner can be linked by the
        // existing macOS build without changing its framework list.
        if (!dlopen("/System/Library/Frameworks/Vision.framework/Vision", RTLD_LAZY | RTLD_LOCAL) ||
            !NSClassFromString(@"VNDetectBarcodesRequest") || !NSClassFromString(@"VNImageRequestHandler")) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!self.stopped) [self finishWithValue:nil error:@"QR detection is unavailable on this Mac"];
            });
            return;
        }
        // Virtual cameras can be the system default while producing no frames.
        // Prefer the built-in camera for scanning when one exists.
        AVCaptureDeviceDiscoverySession *discovery = [AVCaptureDeviceDiscoverySession
            discoverySessionWithDeviceTypes:@[AVCaptureDeviceTypeBuiltInWideAngleCamera]
            mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified];
        AVCaptureDevice *device = discovery.devices.firstObject ?: [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
        NSLog(@"Ponlet QR scan %llu: selected camera %@", self.scanID, device.localizedName);
        NSString *failure = nil;
        AVCaptureSession *session = nil;
        AVCaptureVideoDataOutput *output = nil;
        if (!device) {
            failure = @"No camera is available";
        } else {
            NSError *error = nil;
            AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
            if (!input) {
                failure = error.localizedDescription ?: @"Cannot open the camera";
            } else {
                session = [[AVCaptureSession alloc] init];
                output = [[AVCaptureVideoDataOutput alloc] init];
                output.alwaysDiscardsLateVideoFrames = YES;
                [session beginConfiguration];
                if ([session canAddInput:input]) [session addInput:input];
                else failure = @"Cannot configure the camera input";
                if (!failure) {
                    if ([session canAddOutput:output]) [session addOutput:output];
                    else failure = @"Cannot configure QR detection";
                }
                if (!failure) [output setSampleBufferDelegate:self queue:self.frameQueue];
                [session commitConfiguration];
            }
        }
        NSLog(@"Ponlet QR scan %llu: camera configured (%@)", self.scanID, failure ?: @"ready");
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.stopped) return;
            if (failure) {
                [self finishWithValue:nil error:failure];
                return;
            }
            [self startCameraSession:session output:output];
        });
    });
}

- (void)startCameraSession:(AVCaptureSession *)session output:(AVCaptureVideoDataOutput *)output {
    self.session = session;
    self.videoOutput = output;
    [self timeoutAfter:15 stage:@"startup"];

    // startRunning/stopRunning can block; serialize them away from AppKit's UI queue.
    dispatch_async(self.cameraQueue, ^{
        if (!self.stopped) [session startRunning];
        NSLog(@"Ponlet QR scan %llu: capture running %d", self.scanID, session.isRunning);
        if (self.stopped && session.isRunning) [session stopRunning];
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.stopped) return;
            if (!session.isRunning) {
                [self finishWithValue:nil error:@"Camera could not start capturing video"];
            } else {
                [self timeoutAfter:15 stage:@"first video frame"];
            }
        });
    });
}

- (void)sendPreviewForBuffer:(CMSampleBufferRef)buffer {
    CVImageBufferRef pixels = CMSampleBufferGetImageBuffer(buffer);
    if (!pixels) return;
    CIImage *image = [CIImage imageWithCVPixelBuffer:pixels];
    CGRect extent = image.extent;
    CGFloat longestSide = MAX(CGRectGetWidth(extent), CGRectGetHeight(extent));
    if (longestSide <= 0) return;
    CGFloat scale = MIN(1.0, 480.0 / longestSide);
    if (!self.imageContext) self.imageContext = [CIContext contextWithOptions:nil];
    CIImage *smallImage = [image imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
    CGImageRef cgImage = [self.imageContext createCGImage:smallImage fromRect:smallImage.extent];
    if (!cgImage) return;
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cgImage];
    CGImageRelease(cgImage);
    NSData *jpeg = [bitmap representationUsingType:NSBitmapImageFileTypeJPEG
        properties:@{NSImageCompressionFactor: @0.35}];
    if (!jpeg) return;
    NSString *dataURL = [@"data:image/jpeg;base64," stringByAppendingString:[jpeg base64EncodedStringWithOptions:0]];
    // The sample buffer never leaves the delegate queue. The string is retained
    // by this block; the Rust context is used only on the main queue, where
    // completion also frees it, and only while the scan is active.
    dispatch_async(dispatch_get_main_queue(), ^{
        if (activeScanner == self && !self.stopped) {
            self.previewFrame(self.context, self.scanID, dataURL.UTF8String);
        }
    });
}

- (void)captureOutput:(AVCaptureOutput *)output didOutputSampleBuffer:(CMSampleBufferRef)buffer
    fromConnection:(AVCaptureConnection *)connection {
    if (self.stopped) return;
    static const CFTimeInterval minimumFrameInterval = 0.2;
    // This delegate's serial queue owns the timestamp and drops excess frames.
    CFTimeInterval now = CFAbsoluteTimeGetCurrent();
    if (now - self.lastFrameTime < minimumFrameInterval) return;
    self.lastFrameTime = now;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.stopped && [self.startupStage isEqualToString:@"first video frame"]) {
            NSLog(@"Ponlet QR scan %llu: first video frame received", self.scanID);
            self.startupStage = nil;
        }
    });
    VNDetectBarcodesRequest *request = [(VNDetectBarcodesRequest *)[NSClassFromString(@"VNDetectBarcodesRequest") alloc] init];
    VNImageRequestHandler *handler = [(VNImageRequestHandler *)[NSClassFromString(@"VNImageRequestHandler") alloc]
        initWithCMSampleBuffer:buffer options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[request] error:&error]) {
        NSLog(@"Ponlet QR scan %llu: QR detection failed: %@", self.scanID, error);
        if (++self.detectionFailures == 3) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!self.stopped) [self finishWithValue:nil error:@"Cannot process video from this camera"];
            });
        }
        return;
    }
    self.detectionFailures = 0;
    for (VNBarcodeObservation *observation in request.results) {
        if ([observation.symbology isEqualToString:@"VNBarcodeSymbologyQR"] && observation.payloadStringValue.length) {
            NSString *value = observation.payloadStringValue;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!self.stopped) [self finishWithValue:value error:nil];
            });
            return;
        }
    }
    if (!self.stopped) [self sendPreviewForBuffer:buffer];
}

- (void)finishWithValue:(NSString *)value error:(NSString *)error {
    if (self.stopped) return;
    // Clearing activeScanner can release the last strong reference to self.
    // Keep it alive until the callback has consumed its context and strings.
    __attribute__((objc_precise_lifetime)) PonletQrScanner *scanner = self;
    PonletScanCompletion completion = scanner.completion;
    void *context = scanner.context;
    self.stopped = YES;
    self.startupStage = nil;
    NSLog(@"Ponlet QR scan %llu: finished (%@)", self.scanID, error ?: (value ? @"decoded" : @"cancelled"));
    [self.videoOutput setSampleBufferDelegate:nil queue:NULL];
    AVCaptureSession *session = self.session;
    if (self.cameraQueue) {
        dispatch_async(self.cameraQueue, ^{
            if (session.isRunning) [session stopRunning];
        });
    }
    self.session = nil;
    self.videoOutput = nil;
    if (activeScanner == self) activeScanner = nil;
    completion(context, value.UTF8String, error.UTF8String);
}
@end

void ponlet_macos_scan_qr(uint64_t scanID, void *context, PonletScanCompletion completion,
    PonletPreviewFrame previewFrame) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSLog(@"Ponlet QR scan %llu: request received", scanID);
        NSNumber *identifier = @(scanID);
        if ([cancelledIDs containsObject:identifier]) {
            [cancelledIDs removeObject:identifier];
            completion(context, NULL, NULL);
            return;
        }
        if (activeScanner) {
            completion(context, NULL, "A camera scan is already in progress");
            return;
        }
        PonletQrScanner *scanner = [[PonletQrScanner alloc] init];
        scanner.scanID = scanID;
        scanner.context = context;
        scanner.completion = completion;
        scanner.previewFrame = previewFrame;
        activeScanner = scanner;
        [scanner start];
    });
}

void ponlet_macos_cancel_scan(uint64_t scanID) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSLog(@"Ponlet QR scan %llu: cancel received", scanID);
        if (!cancelledIDs) cancelledIDs = [NSMutableSet set];
        if (activeScanner && activeScanner.scanID == scanID) {
            [activeScanner finishWithValue:nil error:nil];
        } else {
            // Cancellation may overtake the invoke that starts this scan.
            // Bound stale IDs if the WebView repeatedly closes before starting.
            if (cancelledIDs.count >= 128) [cancelledIDs removeAllObjects];
            [cancelledIDs addObject:@(scanID)];
        }
    });
}
