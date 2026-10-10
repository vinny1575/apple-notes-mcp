"""Load native AX code into the existing permission-owning Python process."""
import ctypes
import json
import sys
lib = ctypes.CDLL(sys.argv[1])
lib.notes_toggle.argtypes = [ctypes.c_char_p]
lib.notes_toggle.restype = ctypes.c_void_p
lib.notes_free.argtypes = [ctypes.c_void_p]
p = lib.notes_toggle(sys.stdin.buffer.read())
if not p:
    print(json.dumps({'ok': False, 'reason': 'native'}))
    sys.exit(1)
try:
    print(ctypes.string_at(p).decode())
finally:
    lib.notes_free(p)
