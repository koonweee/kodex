#pragma once
#include <CoreFoundation/CoreFoundation.h>
#include <stdbool.h>
#include <sys/types.h>

bool kodex_session_allows_virtual_display(CFTypeRef users, uid_t owner);
bool kodex_console_is_locked(void);

// -1 unknown/ambiguous, 0 unlocked, 1 locked for the effective user console.
int kodex_session_lock_state(CFTypeRef users, uid_t owner);
int kodex_console_lock_state(void);
