// Kodex fixed connection-owned main display. Private CGVirtualDisplay declarations: DeskPad/MIT.
#import "CGVirtualDisplayPrivate.h"
#import <signal.h>
#import <math.h>
#import <stdio.h>
#import <sys/stat.h>
#import <unistd.h>

static CGVirtualDisplay *display;
static dispatch_source_t inputSource, termSource, interruptSource, parentSource;
static pid_t parent;
static unsigned int readinessAttempts;
static BOOL configuredMain;

// App-only scope lets WindowServer restore the saved session configuration
// on every process exit, including SIGKILL. Never write permanent preferences.
static BOOL makeMain(CGDirectDisplayID identifier) {
    typedef struct { CGDirectDisplayID identifier; CGRect bounds; CGDisplayModeRef mode; } Layout;
    uint32_t count = 0;
    if (CGGetOnlineDisplayList(0, NULL, &count) != kCGErrorSuccess || !count) return NO;
    CGDirectDisplayID *identifiers = calloc(count, sizeof(*identifiers));
    Layout *layout = calloc(count, sizeof(*layout));
    BOOL success = NO, found = NO;
    CGDisplayConfigRef configuration = NULL;
    if (!identifiers || !layout || CGGetOnlineDisplayList(count, identifiers, &count) != kCGErrorSuccess) goto done;
    CGPoint offset = CGDisplayBounds(identifier).origin;
    for (uint32_t i = 0; i < count; i++) {
        CGDirectDisplayID current = identifiers[i];
        // Configuring an origin can unmirror a display; leave mirrored setups alone.
        if (CGDisplayIsInMirrorSet(current)) goto done;
        CGRect bounds = CGDisplayBounds(current);
        double x = bounds.origin.x - offset.x, y = bounds.origin.y - offset.y;
        if (!isfinite(x) || !isfinite(y) || x != trunc(x) || y != trunc(y) ||
            x < INT32_MIN || x > INT32_MAX || y < INT32_MIN || y > INT32_MAX) goto done;
        layout[i].identifier = current;
        layout[i].bounds = CGRectMake(x, y, bounds.size.width, bounds.size.height);
        layout[i].mode = CGDisplayCopyDisplayMode(current);
        if (!layout[i].mode) goto done;
        found |= current == identifier;
    }
    if (!found || CGBeginDisplayConfiguration(&configuration) != kCGErrorSuccess) goto done;
    for (uint32_t i = 0; i < count; i++) {
        if (layout[i].identifier == identifier) continue;
        if (CGConfigureDisplayOrigin(configuration, layout[i].identifier,
                (int32_t)layout[i].bounds.origin.x, (int32_t)layout[i].bounds.origin.y) != kCGErrorSuccess) goto done;
    }
    if (CGConfigureDisplayOrigin(configuration, identifier, 0, 0) != kCGErrorSuccess) goto done;
    CGError result = CGCompleteDisplayConfiguration(configuration, kCGConfigureForAppOnly);
    configuration = NULL; // Complete consumes the transaction even on failure.
    if (result != kCGErrorSuccess || CGMainDisplayID() != identifier) goto done;
    uint32_t after = 0;
    if (CGGetOnlineDisplayList(0, NULL, &after) != kCGErrorSuccess || after != count) goto done;
    for (uint32_t i = 0; i < count; i++) {
        CGDisplayModeRef mode = CGDisplayCopyDisplayMode(layout[i].identifier), original = layout[i].mode;
        BOOL unchanged = mode && CGDisplayIsOnline(layout[i].identifier) &&
            CGRectEqualToRect(CGDisplayBounds(layout[i].identifier), layout[i].bounds) &&
            CGDisplayModeGetIODisplayModeID(mode) == CGDisplayModeGetIODisplayModeID(original) &&
            CGDisplayModeGetWidth(mode) == CGDisplayModeGetWidth(original) &&
            CGDisplayModeGetHeight(mode) == CGDisplayModeGetHeight(original) &&
            CGDisplayModeGetPixelWidth(mode) == CGDisplayModeGetPixelWidth(original) &&
            CGDisplayModeGetPixelHeight(mode) == CGDisplayModeGetPixelHeight(original) &&
            fabs(CGDisplayModeGetRefreshRate(mode) - CGDisplayModeGetRefreshRate(original)) < 0.1;
        if (mode) CGDisplayModeRelease(mode);
        if (!unchanged) goto done;
    }
    success = YES;
done:
    if (configuration) CGCancelDisplayConfiguration(configuration);
    if (layout) for (uint32_t i = 0; i < count; i++) if (layout[i].mode) CGDisplayModeRelease(layout[i].mode);
    free(layout); free(identifiers);
    return success;
}

static void finish(int status) {
    display = nil;
    exit(status);
}
static void report(BOOL startup) {
    CGDirectDisplayID identifier = display.displayID;
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(identifier);
    if (!mode || !CGDisplayIsOnline(identifier) ||
        CGDisplayModeGetWidth(mode) != 1200 || CGDisplayModeGetHeight(mode) != 900 ||
        CGDisplayModeGetPixelWidth(mode) != 1200 || CGDisplayModeGetPixelHeight(mode) != 900 ||
        fabs(CGDisplayModeGetRefreshRate(mode) - 60) > 0.1) {
        if (mode) CGDisplayModeRelease(mode);
        if (startup && ++readinessAttempts < 80) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_MSEC * 50), dispatch_get_main_queue(), ^{ report(YES); });
            return;
        }
        finish(2);
    }
    CGDisplayModeRelease(mode);
    if (startup && !configuredMain) {
        if (!makeMain(identifier)) finish(2);
        configuredMain = YES;
    }
    if (!configuredMain || CGMainDisplayID() != identifier) finish(2);
    CGRect bounds = CGDisplayBounds(identifier);
    printf("{\"x\":%.0f,\"y\":%.0f,\"width\":1200,\"height\":900}\n", bounds.origin.x, bounds.origin.y);
    fflush(stdout);
}
int kodex_virtual_display_main(void) {
    @autoreleasepool {
        struct stat input;
        parent = getppid();
        if (parent <= 1 || fstat(STDIN_FILENO, &input) || !S_ISFIFO(input.st_mode)) return 1;
        @try {
            CGVirtualDisplayDescriptor *descriptor = [CGVirtualDisplayDescriptor new];
            [descriptor setDispatchQueue:dispatch_get_main_queue()];
            descriptor.name = @"Kodex Desktop";
            descriptor.maxPixelsWide = 1200;
            descriptor.maxPixelsHigh = 900;
            descriptor.sizeInMillimeters = CGSizeMake(320, 240);
            descriptor.vendorID = 0x4b58;
            descriptor.productID = 0x1209;
            descriptor.serialNum = 0x4b581209;
            display = [[CGVirtualDisplay alloc] initWithDescriptor:descriptor];
            if (!display) return 1;
            CGVirtualDisplaySettings *settings = [CGVirtualDisplaySettings new];
            settings.hiDPI = 0;
            settings.modes = @[[[CGVirtualDisplayMode alloc] initWithWidth:1200 height:900 refreshRate:60]];
            if (![display applySettings:settings]) { display = nil; return 2; }
            signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGPIPE, SIG_IGN);
            termSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
            interruptSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
            dispatch_source_set_event_handler(termSource, ^{ finish(0); });
            dispatch_source_set_event_handler(interruptSource, ^{ finish(0); });
            dispatch_resume(termSource); dispatch_resume(interruptSource);
            inputSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
            dispatch_source_set_event_handler(inputSource, ^{
                char bytes[64];
                ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
                if (count <= 0) finish(0);
                for (ssize_t i = 0; i < count; i++) report(NO);
            });
            dispatch_resume(inputSource);
            parentSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
            dispatch_source_set_timer(parentSource, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 50);
            dispatch_source_set_event_handler(parentSource, ^{
                if (getppid() != parent) finish(0);
                if (configuredMain && (!CGDisplayIsOnline(display.displayID) || CGMainDisplayID() != display.displayID)) finish(2);
            });
            dispatch_resume(parentSource);
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_MSEC * 100), dispatch_get_main_queue(), ^{ report(YES); });
            [[NSRunLoop mainRunLoop] run];
        } @catch (NSException *exception) {
            (void)exception;
            display = nil;
            return 1;
        }
    }
    return 0;
}
