// Kodex fixed secondary display. Private CGVirtualDisplay declarations: DeskPad/MIT.
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

static void finish(int status) {
    display = nil;
    exit(status);
}
static void report(BOOL startup) {
    CGDirectDisplayID identifier = display.displayID;
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(identifier);
    if (!mode || !CGDisplayIsOnline(identifier) || CGMainDisplayID() == identifier ||
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
            dispatch_source_set_event_handler(parentSource, ^{ if (getppid() != parent) finish(0); });
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
