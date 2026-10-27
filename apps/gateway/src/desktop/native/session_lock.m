// Read lock state without initializing CoreGraphics before virtual creation.
#import "session_lock.h"
#import <IOKit/IOKitLib.h>
#import <unistd.h>

int kodex_session_lock_state(CFTypeRef users, uid_t owner) {
    if (!users || CFGetTypeID(users) != CFArrayGetTypeID()) return -1;
    bool found = false;
    int state = -1;
    for (CFIndex i = 0; i < CFArrayGetCount(users); i++) {
        CFTypeRef entry = CFArrayGetValueAtIndex(users, i);
        if (CFGetTypeID(entry) != CFDictionaryGetTypeID()) continue;
        CFTypeRef identifier = CFDictionaryGetValue(entry, CFSTR("kCGSSessionUserIDKey"));
        int64_t user = -1;
        if (!identifier || CFGetTypeID(identifier) != CFNumberGetTypeID() ||
            !CFNumberGetValue(identifier, kCFNumberSInt64Type, &user) || user != owner) continue;
        if (CFDictionaryGetValue(entry, CFSTR("kCGSSessionOnConsoleKey")) != kCFBooleanTrue) continue;
        if (found) return -1; // Ambiguous own-console inventory is conservative.
        found = true;
        CFTypeRef locked = CFDictionaryGetValue(entry, CFSTR("CGSSessionScreenIsLocked"));
        // This key is absent on an unlocked console. Malformed state is conservative.
        if (!locked) state = 0;
        else if (CFGetTypeID(locked) == CFBooleanGetTypeID()) state = CFBooleanGetValue(locked) ? 1 : 0;
    }
    return found ? state : -1;
}

bool kodex_session_allows_virtual_display(CFTypeRef users, uid_t owner) {
    return kodex_session_lock_state(users, owner) == 0;
}

int kodex_console_lock_state(void) {
    io_registry_entry_t root = IORegistryGetRootEntry(kIOMainPortDefault);
    if (!root) return -1;
    CFTypeRef users = IORegistryEntryCreateCFProperty(root, CFSTR("IOConsoleUsers"), kCFAllocatorDefault, 0);
    IOObjectRelease(root);
    int state = kodex_session_lock_state(users, geteuid());
    if (users) CFRelease(users);
    return state;
}

bool kodex_console_is_locked(void) {
    return kodex_console_lock_state() != 0;
}
