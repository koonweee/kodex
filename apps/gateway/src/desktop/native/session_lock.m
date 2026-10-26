// Read lock state without initializing CoreGraphics before virtual creation.
#import "session_lock.h"
#import <IOKit/IOKitLib.h>
#import <unistd.h>

bool kodex_session_allows_virtual_display(CFTypeRef users, uid_t owner) {
    if (!users || CFGetTypeID(users) != CFArrayGetTypeID()) return false;
    bool found = false, allowed = false;
    for (CFIndex i = 0; i < CFArrayGetCount(users); i++) {
        CFTypeRef entry = CFArrayGetValueAtIndex(users, i);
        if (CFGetTypeID(entry) != CFDictionaryGetTypeID()) continue;
        CFTypeRef identifier = CFDictionaryGetValue(entry, CFSTR("kCGSSessionUserIDKey"));
        int64_t user = -1;
        if (!identifier || CFGetTypeID(identifier) != CFNumberGetTypeID() ||
            !CFNumberGetValue(identifier, kCFNumberSInt64Type, &user) || user != owner) continue;
        if (CFDictionaryGetValue(entry, CFSTR("kCGSSessionOnConsoleKey")) != kCFBooleanTrue) continue;
        if (found) return false; // Ambiguous own-console inventory is conservative.
        found = true;
        CFTypeRef locked = CFDictionaryGetValue(entry, CFSTR("CGSSessionScreenIsLocked"));
        // This key is absent on an unlocked console. Malformed state is conservative.
        allowed = !locked || (CFGetTypeID(locked) == CFBooleanGetTypeID() && !CFBooleanGetValue(locked));
    }
    return found && allowed;
}

bool kodex_console_is_locked(void) {
    io_registry_entry_t root = IORegistryGetRootEntry(kIOMainPortDefault);
    if (!root) return true;
    CFTypeRef users = IORegistryEntryCreateCFProperty(root, CFSTR("IOConsoleUsers"), kCFAllocatorDefault, 0);
    IOObjectRelease(root);
    bool allowed = kodex_session_allows_virtual_display(users, geteuid());
    if (users) CFRelease(users);
    return !allowed;
}
