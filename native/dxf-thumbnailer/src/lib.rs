//! Windows Explorer thumbnail provider for `.dxf` drawings.
//!
//! Implements an in-process COM server exposing `IThumbnailProvider`
//! (initialised via `IInitializeWithFile`). Explorer calls `GetThumbnail`,
//! we parse the DXF and rasterise it to an HBITMAP with GDI. Shares the
//! rendering intent (dark background, light strokes, fit-to-box) with the
//! Sketchor web thumbnails.
//!
//! Build:   cargo build --release
//! Register (admin): regsvr32 dxf_thumbnailer.dll
//! Unregister:       regsvr32 /u dxf_thumbnailer.dll

pub mod dxf;
pub mod render;

use std::ffi::c_void;
use std::sync::atomic::{AtomicI32, Ordering};

use windows::core::{implement, IUnknown, Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{
    BOOL, CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_INVALIDARG, E_NOINTERFACE,
    E_UNEXPECTED, HMODULE, S_FALSE, S_OK,
};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::UI::Shell::PropertiesSystem::{
    IInitializeWithFile, IInitializeWithFile_Impl,
};
use windows::Win32::UI::Shell::{
    IThumbnailProvider, IThumbnailProvider_Impl, WTSAT_RGB, WTS_ALPHATYPE,
};

use std::cell::RefCell;

// CLSID for this provider: {6F9E2A31-7C4B-4D8E-9A1F-2B3C4D5E6F70}
const CLSID_DXF_THUMB: GUID = GUID::from_u128(0x6f9e2a31_7c4b_4d8e_9a1f_2b3c4d5e6f70);
// Shell's IThumbnailProvider category GUID under .ext\ShellEx.
const SHELLEX_THUMB: &str = "{E357FCCD-A995-4576-B01F-234630154E96}";

static LOCKS: AtomicI32 = AtomicI32::new(0);
static mut MODULE: HMODULE = HMODULE(std::ptr::null_mut());

/* ----------------------------- provider ----------------------------- */

#[implement(IThumbnailProvider, IInitializeWithFile)]
struct DxfThumb {
    path: RefCell<Option<String>>,
}

impl IInitializeWithFile_Impl for DxfThumb_Impl {
    fn Initialize(&self, pszfilepath: &PCWSTR, _grfmode: u32) -> windows::core::Result<()> {
        let path = unsafe { pszfilepath.to_string() }.map_err(|_| E_INVALIDARG)?;
        *self.path.borrow_mut() = Some(path);
        Ok(())
    }
}

impl IThumbnailProvider_Impl for DxfThumb_Impl {
    fn GetThumbnail(
        &self,
        cx: u32,
        phbmp: *mut windows::Win32::Graphics::Gdi::HBITMAP,
        pdwalpha: *mut WTS_ALPHATYPE,
    ) -> windows::core::Result<()> {
        if phbmp.is_null() {
            return Err(E_INVALIDARG.into());
        }
        let path = self
            .path
            .borrow()
            .clone()
            .ok_or_else(|| windows::core::Error::from(E_UNEXPECTED))?;
        let text = std::fs::read_to_string(&path).map_err(|_| E_UNEXPECTED)?;
        let shapes = dxf::parse(&text);
        let hbmp = render::render_thumbnail(&shapes, cx.max(16))
            .map_err(|_| windows::core::Error::from(E_UNEXPECTED))?;
        unsafe {
            *phbmp = hbmp;
            if !pdwalpha.is_null() {
                *pdwalpha = WTSAT_RGB;
            }
        }
        Ok(())
    }
}

/* --------------------------- class factory -------------------------- */

#[implement(IClassFactory)]
struct Factory;

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Option<&IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut c_void,
    ) -> windows::core::Result<()> {
        unsafe {
            if !ppvobject.is_null() {
                *ppvobject = std::ptr::null_mut();
            }
        }
        if punkouter.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let provider: IUnknown = DxfThumb {
            path: RefCell::new(None),
        }
        .into();
        unsafe { provider.query(riid, ppvobject).ok() }
    }

    fn LockServer(&self, flock: BOOL) -> windows::core::Result<()> {
        if flock.as_bool() {
            LOCKS.fetch_add(1, Ordering::SeqCst);
        } else {
            LOCKS.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

/* ------------------------------ exports ----------------------------- */

#[no_mangle]
extern "system" fn DllMain(hinst: HMODULE, reason: u32, _reserved: *mut c_void) -> BOOL {
    // DLL_PROCESS_ATTACH == 1
    if reason == 1 {
        unsafe { MODULE = hinst };
    }
    true.into()
}

#[no_mangle]
extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    unsafe {
        if ppv.is_null() {
            return E_INVALIDARG;
        }
        *ppv = std::ptr::null_mut();
        if *rclsid != CLSID_DXF_THUMB {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = Factory.into();
        match factory.query(riid, ppv) {
            S_OK => S_OK,
            _ => E_NOINTERFACE,
        }
    }
}

#[no_mangle]
extern "system" fn DllCanUnloadNow() -> HRESULT {
    if LOCKS.load(Ordering::SeqCst) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

fn module_path() -> String {
    let mut buf = [0u16; 260];
    let len = unsafe { GetModuleFileNameW(MODULE, &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..len])
}

#[no_mangle]
extern "system" fn DllRegisterServer() -> HRESULT {
    let clsid = format!("{{{:?}}}", CLSID_DXF_THUMB);
    let dll = module_path();
    if register(&clsid, &dll).is_err() {
        return E_UNEXPECTED;
    }
    S_OK
}

#[no_mangle]
extern "system" fn DllUnregisterServer() -> HRESULT {
    let clsid = format!("{{{:?}}}", CLSID_DXF_THUMB);
    let _ = unregister(&clsid);
    S_OK
}

/* --------------------------- registration --------------------------- */

use windows::core::PCWSTR as RegStr;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Per-user class-registration root. We register under `HKCU\Software\Classes`
/// rather than `HKEY_CLASSES_ROOT`: `.dxf` and `CLSID` already exist in the
/// machine-wide HKLM hive, so a non-elevated `HKCR` write resolves toward HKLM
/// and fails with ACCESS_DENIED (regsvr32 exit 5) — silently dropping the
/// handler. HKCU always succeeds and Explorer merges it into HKCR at read time.
fn classes(path: &str) -> String {
    format!("Software\\Classes\\{path}")
}

fn create_key(path: &str) -> Result<HKEY, ()> {
    let mut hkey = HKEY::default();
    let p = wide(&classes(path));
    let rc = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            RegStr(p.as_ptr()),
            0,
            RegStr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            None,
        )
    };
    if rc.is_ok() {
        Ok(hkey)
    } else {
        Err(())
    }
}

fn set_string(path: &str, name: Option<&str>, value: &str) -> Result<(), ()> {
    let hkey = create_key(path)?;
    let val = wide(value);
    let bytes = unsafe {
        std::slice::from_raw_parts(val.as_ptr() as *const u8, val.len() * 2)
    };
    let name_w = name.map(wide);
    let name_ptr = name_w
        .as_ref()
        .map(|n| RegStr(n.as_ptr()))
        .unwrap_or(RegStr::null());
    let rc = unsafe { RegSetValueExW(hkey, name_ptr, 0, REG_SZ, Some(bytes)) };
    unsafe { let _ = RegCloseKey(hkey); };
    if rc.is_ok() {
        Ok(())
    } else {
        Err(())
    }
}

fn set_dword(path: &str, name: &str, value: u32) -> Result<(), ()> {
    let hkey = create_key(path)?;
    let bytes = value.to_ne_bytes();
    let name_w = wide(name);
    let rc = unsafe {
        RegSetValueExW(hkey, RegStr(name_w.as_ptr()), 0, REG_DWORD, Some(&bytes))
    };
    unsafe { let _ = RegCloseKey(hkey); };
    if rc.is_ok() {
        Ok(())
    } else {
        Err(())
    }
}

fn register(clsid: &str, dll: &str) -> Result<(), ()> {
    let base = format!("CLSID\\{clsid}");
    set_string(&base, None, "Sketchor DXF Thumbnail Provider")?;
    let inproc = format!("{base}\\InprocServer32");
    set_string(&inproc, None, dll)?;
    set_string(&inproc, Some("ThreadingModel"), "Apartment")?;
    // Allow IInitializeWithFile (file path) instead of stream isolation.
    set_dword(&base, "DisableProcessIsolation", 1)?;
    // Associate .dxf with this thumbnail provider. Register at the extension
    // level and under SystemFileAssociations (the shell consults both, and the
    // latter survives even if another app owns the .dxf ProgID).
    set_string(&format!(".dxf\\ShellEx\\{SHELLEX_THUMB}"), None, clsid)?;
    set_string(
        &format!("SystemFileAssociations\\.dxf\\ShellEx\\{SHELLEX_THUMB}"),
        None,
        clsid,
    )?;
    Ok(())
}

fn unregister(clsid: &str) -> Result<(), ()> {
    let base = wide(&classes(&format!("CLSID\\{clsid}")));
    let assoc = wide(&classes(&format!(".dxf\\ShellEx\\{SHELLEX_THUMB}")));
    let sysassoc = wide(&classes(&format!(
        "SystemFileAssociations\\.dxf\\ShellEx\\{SHELLEX_THUMB}"
    )));
    unsafe {
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, RegStr(base.as_ptr()));
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, RegStr(assoc.as_ptr()));
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, RegStr(sysassoc.as_ptr()));
    }
    Ok(())
}
