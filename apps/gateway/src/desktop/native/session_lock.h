#pragma once
#include <CoreFoundation/CoreFoundation.h>
#include <stdbool.h>
#include <sys/types.h>

bool kodex_session_allows_virtual_display(CFTypeRef users, uid_t owner);
bool kodex_console_is_locked(void);
