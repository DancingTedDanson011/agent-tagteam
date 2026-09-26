// Thin koffi bindings for the Win32 calls this app needs. Signatures only — no logic.
// Koffi 3 represents pointers (HWND, HANDLE, HDC, …) as BigInt.
import koffi from 'koffi'

export type HWND = bigint

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const dwmapi = koffi.load('dwmapi.dll')
const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')
const ntdll = koffi.load('ntdll.dll')

export const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
export const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
export const WINDOWPLACEMENT = koffi.struct('WINDOWPLACEMENT', {
  length: 'uint32',
  flags: 'uint32',
  showCmd: 'uint32',
  ptMinPosition: POINT,
  ptMaxPosition: POINT,
  rcNormalPosition: RECT
})
export const FILETIME = koffi.struct('FILETIME', { low: 'uint32', high: 'uint32' })
export const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32'
})
export const DWM_THUMBNAIL_PROPERTIES = koffi.struct('DWM_THUMBNAIL_PROPERTIES', {
  dwFlags: 'uint32',
  rcDestination: RECT,
  rcSource: RECT,
  opacity: 'uint8',
  fVisible: 'int32',
  fSourceClientAreaOnly: 'int32'
})

export const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'void *',
  lpDesktop: 'void *',
  lpTitle: 'void *',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'void *',
  hStdInput: 'void *',
  hStdOutput: 'void *',
  hStdError: 'void *'
})
export const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void *',
  hThread: 'void *',
  dwProcessId: 'uint32',
  dwThreadId: 'uint32'
})

export type Rect = { left: number; top: number; right: number; bottom: number }
export type Point = { x: number; y: number }
export type WindowPlacement = {
  length: number
  flags: number
  showCmd: number
  ptMinPosition: Point
  ptMaxPosition: Point
  rcNormalPosition: Rect
}

export const EnumWindowsProc = koffi.proto('int32 __stdcall EnumWindowsProc(void *hwnd, intptr lparam)')

// user32
export const EnumWindows = user32.func('int32 __stdcall EnumWindows(EnumWindowsProc *cb, intptr lparam)')
export const GetClassNameW = user32.func('int32 __stdcall GetClassNameW(void *hwnd, _Out_ uint16_t *buf, int32 max)')
export const GetWindowTextW = user32.func('int32 __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *buf, int32 max)')
export const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)'
)
export const IsWindow = user32.func('int32 __stdcall IsWindow(void *hwnd)')
export const IsWindowVisible = user32.func('int32 __stdcall IsWindowVisible(void *hwnd)')
export const IsIconic = user32.func('int32 __stdcall IsIconic(void *hwnd)')
export const IsZoomed = user32.func('int32 __stdcall IsZoomed(void *hwnd)')
export const GetWindow = user32.func('void * __stdcall GetWindow(void *hwnd, uint32 cmd)')
export const IsHungAppWindow = user32.func('int32 __stdcall IsHungAppWindow(void *hwnd)')
export const GetSystemMetrics = user32.func('int32 __stdcall GetSystemMetrics(int32 index)')
export const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int32 key)')
export const GetWindowRect = user32.func('int32 __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)')
export const SetWindowPos = user32.func(
  'int32 __stdcall SetWindowPos(void *hwnd, void *after, int32 x, int32 y, int32 cx, int32 cy, uint32 flags)'
)
export const ShowWindow = user32.func('int32 __stdcall ShowWindow(void *hwnd, int32 cmd)')
export const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(void *hwnd, int32 index)')
export const SetWindowLongPtrW = user32.func('intptr __stdcall SetWindowLongPtrW(void *hwnd, int32 index, intptr value)')
export const GetWindowPlacement = user32.func(
  'int32 __stdcall GetWindowPlacement(void *hwnd, _Inout_ WINDOWPLACEMENT *wp)'
)
export const SetWindowPlacement = user32.func(
  'int32 __stdcall SetWindowPlacement(void *hwnd, const WINDOWPLACEMENT *wp)'
)
export const GetCursorPos = user32.func('int32 __stdcall GetCursorPos(_Out_ POINT *pt)')
export const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
export const SetForegroundWindow = user32.func('int32 __stdcall SetForegroundWindow(void *hwnd)')
// x64 layout: INPUT = type (4) + padding (4) + union (32; KEYBDINPUT is 24 of it) = 40 bytes.
export const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
export const INPUT = koffi.struct('INPUT', { type: 'uint32', ki: KEYBDINPUT, pad: koffi.array('uint8', 8) })
export const SendInput = user32.func('uint32 __stdcall SendInput(uint32 count, INPUT *inputs, int32 size)')
export const GetAncestor = user32.func('void * __stdcall GetAncestor(void *hwnd, uint32 flags)')
export const PrintWindow = user32.func('int32 __stdcall PrintWindow(void *hwnd, void *hdc, uint32 flags)')
export const GetDC = user32.func('void * __stdcall GetDC(void *hwnd)')
export const ReleaseDC = user32.func('int32 __stdcall ReleaseDC(void *hwnd, void *hdc)')
export const PostMessageW = user32.func(
  'int32 __stdcall PostMessageW(void *hwnd, uint32 msg, uintptr wparam, intptr lparam)'
)

// gdi32
export const CreateCompatibleDC = gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)')
export const CreateCompatibleBitmap = gdi32.func(
  'void * __stdcall CreateCompatibleBitmap(void *hdc, int32 cx, int32 cy)'
)
export const SelectObject = gdi32.func('void * __stdcall SelectObject(void *hdc, void *obj)')
export const DeleteObject = gdi32.func('int32 __stdcall DeleteObject(void *obj)')
export const DeleteDC = gdi32.func('int32 __stdcall DeleteDC(void *hdc)')
export const GetDIBits = gdi32.func(
  'int32 __stdcall GetDIBits(void *hdc, void *bmp, uint32 start, uint32 lines, _Out_ uint8_t *bits, _Inout_ BITMAPINFOHEADER *bmi, uint32 usage)'
)

// dwmapi
export const DwmRegisterThumbnail = dwmapi.func(
  'int32 __stdcall DwmRegisterThumbnail(void *dest, void *src, _Out_ void **thumb)'
)
export const DwmUpdateThumbnailProperties = dwmapi.func(
  'int32 __stdcall DwmUpdateThumbnailProperties(void *thumb, const DWM_THUMBNAIL_PROPERTIES *props)'
)
export const DwmUnregisterThumbnail = dwmapi.func('int32 __stdcall DwmUnregisterThumbnail(void *thumb)')

// kernel32 / advapi32
export const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, int32 inherit, uint32 pid)')
export const CloseHandle = kernel32.func('int32 __stdcall CloseHandle(void *h)')
export const CreateProcessW = kernel32.func(
  'int32 __stdcall CreateProcessW(const uint16_t *app, _Inout_ uint16_t *cmdLine, void *procAttr, void *threadAttr, int32 inherit, uint32 flags, void *env, void *cwd, STARTUPINFOW *si, _Out_ PROCESS_INFORMATION *pi)'
)
export const ReadProcessMemory = kernel32.func(
  'int32 __stdcall ReadProcessMemory(void *h, uint64 addr, _Out_ uint8_t *buf, uintptr size, _Out_ uintptr *read)'
)
export const NtQueryInformationProcess = ntdll.func(
  'int32 __stdcall NtQueryInformationProcess(void *h, int32 cls, _Out_ uint8_t *buf, uint32 len, _Out_ uint32 *retLen)'
)
export const GetSystemDirectoryW = kernel32.func('uint32 __stdcall GetSystemDirectoryW(_Out_ uint16_t *buf, uint32 size)')
export const GetShortPathNameW = kernel32.func('uint32 __stdcall GetShortPathNameW(const uint16_t *longPath, _Out_ uint16_t *buf, uint32 size)')
export const GetProcessTimes = kernel32.func(
  'int32 __stdcall GetProcessTimes(void *h, _Out_ FILETIME *creation, _Out_ FILETIME *exit, _Out_ FILETIME *kernel, _Out_ FILETIME *user)'
)
export const QueryFullProcessImageNameW = kernel32.func(
  'int32 __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, _Out_ uint16_t *buf, _Inout_ uint32 *size)'
)
export const OpenProcessToken = advapi32.func(
  'int32 __stdcall OpenProcessToken(void *h, uint32 access, _Out_ void **token)'
)
export const GetTokenInformation = advapi32.func(
  'int32 __stdcall GetTokenInformation(void *token, int32 cls, _Out_ uint32 *info, uint32 len, _Out_ uint32 *retLen)'
)

export { koffi }
