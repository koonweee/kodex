// Offline native state/IOKit policy tests. No real display creation or configuration.
#import "../../../apps/gateway/src/desktop/native/CGVirtualDisplayPrivate.h"
#import "../../../apps/gateway/src/desktop/native/session_lock.h"
#import <assert.h>

static BOOL locked = YES, available = NO;
static unsigned queries;
static bool fixtureLocked(void) { return locked; }
static CGDisplayModeRef fixtureMode(CGDirectDisplayID identifier) { (void)identifier; queries++; return available ? (CGDisplayModeRef)(uintptr_t)1 : NULL; }
static bool fixtureOnline(CGDirectDisplayID identifier) { (void)identifier; queries++; return true; }
static size_t fixtureWidth(CGDisplayModeRef mode) { (void)mode; return 1200; }
static size_t fixtureHeight(CGDisplayModeRef mode) { (void)mode; return 900; }
static double fixtureHz(CGDisplayModeRef mode) { (void)mode; return 60; }
static void fixtureRelease(CGDisplayModeRef mode) { (void)mode; }
static CGDirectDisplayID fixtureMain(void) { queries++; return 777; }
static CGError forbiddenInventory(uint32_t maximum, CGDirectDisplayID *ids, uint32_t *count) { (void)maximum; (void)ids; (void)count; abort(); }
@interface FixtureDisplay : NSObject
@property(readonly) CGDirectDisplayID displayID;
@end
@implementation FixtureDisplay
- (CGDirectDisplayID)displayID { return 777; }
@end
@interface ForbiddenDescriptor : CGVirtualDisplayDescriptor
@end
@implementation ForbiddenDescriptor
+ (instancetype)new { abort(); }
@end
@interface ForbiddenDisplay : CGVirtualDisplay
@end
@implementation ForbiddenDisplay
+ (instancetype)alloc { abort(); }
@end
#define kodex_console_is_locked fixtureLocked
#define CGDisplayCopyDisplayMode fixtureMode
#define CGDisplayIsOnline fixtureOnline
#define CGDisplayModeGetWidth fixtureWidth
#define CGDisplayModeGetPixelWidth fixtureWidth
#define CGDisplayModeGetHeight fixtureHeight
#define CGDisplayModeGetPixelHeight fixtureHeight
#define CGDisplayModeGetRefreshRate fixtureHz
#define CGDisplayModeRelease fixtureRelease
#define CGMainDisplayID fixtureMain
#define CGGetOnlineDisplayList forbiddenInventory
#define CGVirtualDisplayDescriptor ForbiddenDescriptor
#define CGVirtualDisplay ForbiddenDisplay
#import "../../../apps/gateway/src/desktop/native/virtual_display.m"

static void policy(void) {
    NSDictionary *own = @{ @"kCGSSessionUserIDKey": @501, @"kCGSSessionOnConsoleKey": @YES };
    assert(kodex_session_allows_virtual_display((__bridge CFTypeRef)@[own],501));
    for (id value in @[@YES,@NO,@"invalid",@1,@0]) {
        NSMutableDictionary *entry=[own mutableCopy];entry[@"CGSSessionScreenIsLocked"]=value;
        assert(kodex_session_allows_virtual_display((__bridge CFTypeRef)@[entry],501)==(value == (__bridge id)kCFBooleanFalse));
    }
    assert(!kodex_session_allows_virtual_display((__bridge CFTypeRef)@[own,own],501));
    assert(!kodex_session_allows_virtual_display((__bridge CFTypeRef)@[own],502));
    assert(!kodex_session_allows_virtual_display((__bridge CFTypeRef)@[@"invalid"],501));
    assert(!kodex_session_allows_virtual_display((__bridge CFTypeRef)@{},501));
    assert(!kodex_session_allows_virtual_display(NULL,501));
    assert(!kodex_session_allows_virtual_display((__bridge CFTypeRef)@[@{@"kCGSSessionUserIDKey":@501,@"kCGSSessionOnConsoleKey":@NO}],501));
}
static void lifecycle(void) {
    assert(refreshLock()); promote(); report();
    assert(state==Login && generation==1 && !display && queries==0);
    locked=NO; assert(!refreshLock()); assert(state==Transitioning && generation==2);
    // Represent an already-created partial object; creation itself is forbidden
    // in this fixture, so a duplicate/failed reuse aborts rather than touching macOS.
    display=(ForbiddenDisplay *)(id)[FixtureDisplay new]; settingsApplied=YES; configuredMain=YES;
    CGVirtualDisplay *retained=display;
    readinessAttempts=77; promote(); uint64_t token=generation;
    assert(preparing && readinessAttempts==0);
    prepare(token); assert(readinessAttempts==1 && state==Transitioning);
    unsigned before=queries;
    locked=YES; prepare(token); report();
    assert(state==Login && generation==3 && !preparing && display==retained && queries==before);
    locked=NO; assert(!refreshLock()); assert(state==Transitioning && generation==4);
    promote(); assert(preparing && readinessAttempts==0 && display==retained);
    before=queries; prepare(token); assert(queries==before); // stale callback is inert
    available=YES; prepare(generation);
    assert(state==Virtual && generation==5 && !preparing && display==retained);
    locked=YES; before=queries; report();
    assert(state==Login && generation==6 && display==retained && queries==before);
    display=nil;
}
int main(int argc,const char **argv) {
    @autoreleasepool {
        assert(argc==2);
        if (!strcmp(argv[1],"policy")) policy(); else lifecycle();
    }
    puts("native offline checks passed");
}
