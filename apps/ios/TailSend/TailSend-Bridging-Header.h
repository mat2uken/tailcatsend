#ifndef TailSend_Bridging_Header_h
#define TailSend_Bridging_Header_h

#import <Foundation/Foundation.h>

// Rust iOS C-ABI entry points
void tailsend_ios_main(void);
void tailsend_ios_join_session(const char *url_str);

// Swift C-ABI exported functions for Rust to call
void tailsend_swift_open_camera_scanner(void);

#endif /* TailSend_Bridging_Header_h */
