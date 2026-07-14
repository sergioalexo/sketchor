//! Windows Explorer shell extensions for Sketchor's native `.sketchor`
//! drawings. One in-process COM server exposing two handlers:
//!
//! * **`IThumbnailProvider`** — renders the drawing onto the file's icon
//!   (the "icon preview"), initialised via `IInitializeWithFile`.
//! * **`IPreviewHandler`** — renders a large, live picture in Explorer's
//!   reading/preview pane (see `preview.rs`).
//!
//! Both share the GDI rasteriser in `render.rs` and the `.sketchor` JSON
//! parser in `model.rs`, so the icon and the pane always agree.
//!
//! Build:   cargo build --release
//! Install: ./install.ps1   (per-user thumbnail; preview pane needs admin)

pub mod model;
pub mod preview;
pub mod render;

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicI32, Ordering};

use windows::core::{implement, IUnknown, Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{
    BOOL, CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_INVALIDARG, E_NOINTERFACE,
    E_UNEXPECTED, HINSTANCE, HMODULE, S_FALSE, S_OK,
};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithFile, IInitializeWithFile_Impl};
use windows::Win32::UI::Shell::{
    IThumbnailProvider, IThumbnailProvider_Impl, WTSAT_RGB, WTS_ALPHATYPE,
};

use preview::SketchorPreview;

// CLSID of the thumbnail provider: {17697024-A556-4435-9F13-013C67705CC0}
const CLSID_SKETCHOR_THUMB: GUID = GUID::from_u128(0x17697024_a556_4435_9f13_013c67705cc0);
// CLSID of the preview handler:  {B3B58581-063E-40D5-95D6-A203E62749B0}
const CLSID_SKETCHOR_PREVIEW: GUID = GUID::from_u128(0xb3b58581_063e_40d5_95d6_a203e62749b0);

// Shell category GUIDs (the interfaces the shell asks a file type for).
const CAT_THUMBNAIL: &str = "{E357FCCD-A995-4576-B01F-234630154E96}"; // IThumbnailProvider
const CAT_PREVIEW: &str = "{8895B1C6-B41F-4C1C-A562-0D564250836F}"; // IPreviewHandler
// Built-in surrogate host (prevhost.exe) that runs preview handlers.
const APPID_PREVIEW_HOST: &str = "{534A1E02-D58F-44f0-B58B-36CBED287C7C}";

const EXT: &str = ".sketchor";
const PROGID: &str = "Sketchor.Drawing";

static LOCKS: AtomicI32 = AtomicI32::new(0);
static mut MODULE: HMODULE = HMODULE(std::ptr::null_mut());

/// Instance handle of this DLL — used to register/create host windows.
pub(crate) fn hinstance() -> HINSTANCE {
    unsafe { HINSTANCE(MODULE.0) }
}

/* --------------------------- thumbnail ------------------------------ */

#[implement(IThumbnailProvider, IInitializeWithFile)]
struct SketchorThumb {
    path: RefCell<Option<String>>,
}

impl IInitializeWithFile_Impl for SketchorThumb_Impl {
    fn Initialize(&self, pszfilepath: &PCWSTR, _grfmode: u32) -> windows::core::Result<()> {
        let path = unsafe { pszfilepath.to_string() }.map_err(|_| E_INVALIDARG)?;
        *self.path.borrow_mut() = Some(path);
        Ok(())
    }
}

impl IThumbnailProvider_Impl for SketchorThumb_Impl {
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
        let shapes = model::parse(&text);
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
struct Factory {
    clsid: GUID,
}

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
        let unk: IUnknown = if self.clsid == CLSID_SKETCHOR_THUMB {
            SketchorThumb {
                path: RefCell::new(None),
            }
            .into()
        } else if self.clsid == CLSID_SKETCHOR_PREVIEW {
            SketchorPreview::new().into()
        } else {
            return Err(CLASS_E_CLASSNOTAVAILABLE.into());
        };
        unsafe { unk.query(riid, ppvobject).ok() }
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
        let clsid = *rclsid;
        if clsid != CLSID_SKETCHOR_THUMB && clsid != CLSID_SKETCHOR_PREVIEW {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let factory: IClassFactory = Factory { clsid }.into();
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
    let dll = module_path();
    if register(&dll).is_err() {
        return E_UNEXPECTED;
    }
    S_OK
}

#[no_mangle]
extern "system" fn DllUnregisterServer() -> HRESULT {
    let _ = unregister();
    S_OK
}

/* --------------------------- registration --------------------------- */

use windows::core::PCWSTR as RegStr;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyValueW, RegDeleteTreeW, RegSetValueExW, HKEY,
    HKEY_CLASSES_ROOT, HKEY_LOCAL_MACHINE, KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn guid_braced(g: &GUID) -> String {
    format!("{{{:?}}}", g)
}

fn create_key_in(root: HKEY, path: &str) -> Result<HKEY, ()> {
    let mut hkey = HKEY::default();
    let p = wide(path);
    let rc = unsafe {
        RegCreateKeyExW(
            root,
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

fn set_string_in(root: HKEY, path: &str, name: Option<&str>, value: &str) -> Result<(), ()> {
    let hkey = create_key_in(root, path)?;
    let val = wide(value);
    let bytes = unsafe { std::slice::from_raw_parts(val.as_ptr() as *const u8, val.len() * 2) };
    let name_w = name.map(wide);
    let name_ptr = name_w
        .as_ref()
        .map(|n| RegStr(n.as_ptr()))
        .unwrap_or(RegStr::null());
    let rc = unsafe { RegSetValueExW(hkey, name_ptr, 0, REG_SZ, Some(bytes)) };
    unsafe {
        let _ = RegCloseKey(hkey);
    };
    if rc.is_ok() {
        Ok(())
    } else {
        Err(())
    }
}

fn set_string(path: &str, name: Option<&str>, value: &str) -> Result<(), ()> {
    set_string_in(HKEY_CLASSES_ROOT, path, name, value)
}

fn set_dword(path: &str, name: &str, value: u32) -> Result<(), ()> {
    let hkey = create_key_in(HKEY_CLASSES_ROOT, path)?;
    let bytes = value.to_ne_bytes();
    let name_w = wide(name);
    let rc = unsafe { RegSetValueExW(hkey, RegStr(name_w.as_ptr()), 0, REG_DWORD, Some(&bytes)) };
    unsafe {
        let _ = RegCloseKey(hkey);
    };
    if rc.is_ok() {
        Ok(())
    } else {
        Err(())
    }
}

/// Register both CLSIDs and wire them to `.sketchor`.
///
/// Everything except the preview handler's machine-wide "PreviewHandlers"
/// list is written through `HKEY_CLASSES_ROOT`, which redirects to
/// `HKCU\Software\Classes` for a non-elevated (per-user) install. The
/// master list lives in HKLM and only takes effect when the installer runs
/// elevated; its failure is non-fatal so the thumbnail still registers.
fn register(dll: &str) -> Result<(), ()> {
    let thumb = guid_braced(&CLSID_SKETCHOR_THUMB);
    let preview = guid_braced(&CLSID_SKETCHOR_PREVIEW);

    // --- thumbnail provider COM object ---
    let base = format!("CLSID\\{thumb}");
    set_string(&base, None, "Sketchor Thumbnail Provider")?;
    let inproc = format!("{base}\\InprocServer32");
    set_string(&inproc, None, dll)?;
    set_string(&inproc, Some("ThreadingModel"), "Apartment")?;
    set_dword(&base, "DisableProcessIsolation", 1)?;

    // --- preview handler COM object ---
    let pbase = format!("CLSID\\{preview}");
    set_string(&pbase, None, "Sketchor Preview Handler")?;
    set_string(&pbase, Some("AppID"), APPID_PREVIEW_HOST)?;
    // Read the file at medium integrity so IInitializeWithFile can open it.
    set_dword(&pbase, "DisableLowILProcessIsolation", 1)?;
    let pinproc = format!("{pbase}\\InprocServer32");
    set_string(&pinproc, None, dll)?;
    set_string(&pinproc, Some("ThreadingModel"), "Apartment")?;

    // --- file type + ProgID ---
    set_string(EXT, None, PROGID)?;
    set_string(EXT, Some("Content Type"), "application/x-sketchor")?;
    set_string(PROGID, None, "Sketchor Drawing")?;

    // --- associate both handlers (under the ProgID and, as a fallback,
    //     directly under the extension) ---
    for owner in [PROGID, EXT] {
        set_string(&format!("{owner}\\ShellEx\\{CAT_THUMBNAIL}"), None, &thumb)?;
        set_string(&format!("{owner}\\ShellEx\\{CAT_PREVIEW}"), None, &preview)?;
    }

    // --- preview handler master list (machine-wide; best effort) ---
    let _ = set_string_in(
        HKEY_LOCAL_MACHINE,
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\PreviewHandlers",
        Some(&preview),
        "Sketchor Preview Handler",
    );

    Ok(())
}

fn unregister() -> Result<(), ()> {
    let thumb = wide(&format!("CLSID\\{}", guid_braced(&CLSID_SKETCHOR_THUMB)));
    let preview_key = wide(&format!("CLSID\\{}", guid_braced(&CLSID_SKETCHOR_PREVIEW)));
    let progid = wide(PROGID);
    let ext = wide(EXT);
    unsafe {
        let _ = RegDeleteTreeW(HKEY_CLASSES_ROOT, RegStr(thumb.as_ptr()));
        let _ = RegDeleteTreeW(HKEY_CLASSES_ROOT, RegStr(preview_key.as_ptr()));
        let _ = RegDeleteTreeW(HKEY_CLASSES_ROOT, RegStr(progid.as_ptr()));
        let _ = RegDeleteTreeW(HKEY_CLASSES_ROOT, RegStr(ext.as_ptr()));

        // Remove the master-list value (best effort, needs elevation).
        let list = wide("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\PreviewHandlers");
        let val = wide(&guid_braced(&CLSID_SKETCHOR_PREVIEW));
        let _ = RegDeleteKeyValueW(
            HKEY_LOCAL_MACHINE,
            RegStr(list.as_ptr()),
            RegStr(val.as_ptr()),
        );
    }
    Ok(())
}
