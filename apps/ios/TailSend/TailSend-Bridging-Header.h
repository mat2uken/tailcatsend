#ifndef TailSend_Bridging_Header_h
#define TailSend_Bridging_Header_h

#import <Foundation/Foundation.h>

// Rust iOS C-ABI entry points
void tailsend_ios_main(void);
void tailsend_ios_join_session(const char *url_str);
void tailsend_ios_file_picked(const char *path_str, const char *name_str);

// Swift C-ABI exported functions for Rust to call
void tailsend_swift_open_camera_scanner(void);

// Telemetry bridge (Firebase Analytics / Crashlytics / Remote Config)
int tailsend_telemetry_ios_init(void);
void tailsend_telemetry_ios_log_event(const char *name, const char *json_params);
void tailsend_telemetry_ios_set_user_property(const char *name, const char *value);
void tailsend_telemetry_ios_set_enabled(int enabled);
int tailsend_telemetry_ios_remote_string(const char *key, char *out_buf, int buf_len);
int tailsend_telemetry_ios_locale_language(char *out_buf, int buf_len);

#endif /* TailSend_Bridging_Header_h */
