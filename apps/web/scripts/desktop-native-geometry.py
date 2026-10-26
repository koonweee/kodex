# Read-only CoreGraphics inventory for the opt-in native display lifecycle proof.
import ctypes,json
class Point(ctypes.Structure): _fields_=[('x',ctypes.c_double),('y',ctypes.c_double)]
class Size(ctypes.Structure): _fields_=[('width',ctypes.c_double),('height',ctypes.c_double)]
class Rect(ctypes.Structure): _fields_=[('origin',Point),('size',Size)]
c=ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
c.CGGetOnlineDisplayList.argtypes=[ctypes.c_uint32,ctypes.POINTER(ctypes.c_uint32),ctypes.POINTER(ctypes.c_uint32)]
c.CGDisplayBounds.argtypes=[ctypes.c_uint32];c.CGDisplayBounds.restype=Rect
c.CGDisplayCopyDisplayMode.argtypes=[ctypes.c_uint32];c.CGDisplayCopyDisplayMode.restype=ctypes.c_void_p
for name in ['CGDisplayModeGetPixelWidth','CGDisplayModeGetPixelHeight']:
 f=getattr(c,name);f.argtypes=[ctypes.c_void_p];f.restype=ctypes.c_size_t
c.CGDisplayModeRelease.argtypes=[ctypes.c_void_p]
c.CGMainDisplayID.restype=ctypes.c_uint32
c.CGDisplayModeGetRefreshRate.argtypes=[ctypes.c_void_p];c.CGDisplayModeGetRefreshRate.restype=ctypes.c_double
for name in ['CGDisplayModeGetWidth','CGDisplayModeGetHeight']:
 f=getattr(c,name);f.argtypes=[ctypes.c_void_p];f.restype=ctypes.c_size_t
ids=(ctypes.c_uint32*16)();count=ctypes.c_uint32();c.CGGetOnlineDisplayList(16,ids,ctypes.byref(count));result=[]
for i in ids[:count.value]:
 b=c.CGDisplayBounds(i);m=c.CGDisplayCopyDisplayMode(i)
 if not m: continue
 result.append({'id':i,'main':i==c.CGMainDisplayID(),'logical':[c.CGDisplayModeGetWidth(m),c.CGDisplayModeGetHeight(m)],'hz':c.CGDisplayModeGetRefreshRate(m),'pixels':[c.CGDisplayModeGetPixelWidth(m),c.CGDisplayModeGetPixelHeight(m)],'bounds':[b.origin.x,b.origin.y,b.size.width,b.size.height]});c.CGDisplayModeRelease(m)
print(json.dumps(sorted(result,key=lambda d:d["id"])))
