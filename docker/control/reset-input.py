"""Release held X11 keys/buttons and lock modifiers, then wait for XSync."""
import ctypes as c
x=c.CDLL('libX11.so.6'); xt=c.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes=[c.c_char_p]; x.XOpenDisplay.restype=c.c_void_p
x.XQueryKeymap.argtypes=[c.c_void_p,c.c_void_p]
x.XkbLockModifiers.argtypes=[c.c_void_p,c.c_uint,c.c_uint,c.c_uint]
x.XSync.argtypes=[c.c_void_p,c.c_int]; x.XCloseDisplay.argtypes=[c.c_void_p]
xt.XTestFakeKeyEvent.argtypes=[c.c_void_p,c.c_uint,c.c_int,c.c_ulong]
xt.XTestFakeButtonEvent.argtypes=[c.c_void_p,c.c_uint,c.c_int,c.c_ulong]
d=x.XOpenDisplay(None)
if not d: raise RuntimeError('X display unavailable')
keys=(c.c_ubyte*32)(); x.XQueryKeymap(d,keys)
for code in range(8,256):
    if keys[code//8] & (1 << (code%8)): xt.XTestFakeKeyEvent(d,code,0,0)
for button in range(1,10): xt.XTestFakeButtonEvent(d,button,0,0)
if not x.XkbLockModifiers(d,0x100,0xff,0): raise RuntimeError('Cannot reset locked modifiers')
x.XSync(d,0); x.XCloseDisplay(d)
print('input reset')
