//! Explorer **preview-pane** handler for `.sketchor` files.
//!
//! Implements `IPreviewHandler` (+ `IInitializeWithFile` and
//! `IObjectWithSite`). When the user selects a `.sketchor` file, the shell
//! hosts this handler in the `prevhost.exe` surrogate and hands us a parent
//! window and a rectangle. We parse the document and create a child window
//! whose `WM_PAINT` runs the shared GDI rasteriser — a large, live version
//! of the same picture the thumbnail provider draws.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::sync::Once;

use windows::core::{implement, IUnknown, Interface, GUID, PCWSTR};
use windows::Win32::Foundation::{
    COLORREF, E_FAIL, E_INVALIDARG, E_UNEXPECTED, HWND, LPARAM, LRESULT, RECT, S_FALSE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, EndPaint, HBRUSH, PAINTSTRUCT,
};
use windows::Win32::System::Ole::IObjectWithSite_Impl;
use windows::Win32::System::Ole::IObjectWithSite;
use windows::Win32::UI::Shell::IPreviewHandler;
use windows::Win32::UI::Shell::IPreviewHandler_Impl;
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithFile, IInitializeWithFile_Impl};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW, LoadCursorW,
    MoveWindow, RegisterClassW, SetWindowLongPtrW, GWLP_USERDATA, HMENU, IDC_ARROW, MSG,
    WINDOW_EX_STYLE, WM_ERASEBKGND, WM_NCDESTROY, WM_PAINT, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN,
    WS_VISIBLE,
};

use crate::model::Shape;
use crate::{hinstance, render};

const CLASS_NAME: &str = "SketchorPreviewHost";

/* ------------------------------ handler ----------------------------- */

#[implement(IPreviewHandler, IInitializeWithFile, IObjectWithSite)]
pub struct SketchorPreview {
    path: RefCell<Option<String>>,
    parent: Cell<HWND>,
    rect: Cell<RECT>,
    hwnd: Cell<HWND>,
    site: RefCell<Option<IUnknown>>,
}

impl SketchorPreview {
    pub fn new() -> Self {
        Self {
            path: RefCell::new(None),
            parent: Cell::new(HWND::default()),
            rect: Cell::new(RECT::default()),
            hwnd: Cell::new(HWND::default()),
            site: RefCell::new(None),
        }
    }
}

impl SketchorPreview_Impl {
    /// Reposition the child window to match the current rect.
    fn resize_child(&self) {
        let hwnd = self.hwnd.get();
        if !hwnd.is_invalid() {
            let rc = self.rect.get();
            unsafe {
                let _ = MoveWindow(hwnd, rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top, true);
            }
        }
    }
}

impl IInitializeWithFile_Impl for SketchorPreview_Impl {
    fn Initialize(&self, pszfilepath: &PCWSTR, _grfmode: u32) -> windows::core::Result<()> {
        let path = unsafe { pszfilepath.to_string() }.map_err(|_| E_INVALIDARG)?;
        *self.path.borrow_mut() = Some(path);
        Ok(())
    }
}

impl IObjectWithSite_Impl for SketchorPreview_Impl {
    fn SetSite(&self, punksite: Option<&IUnknown>) -> windows::core::Result<()> {
        *self.site.borrow_mut() = punksite.cloned();
        Ok(())
    }

    fn GetSite(&self, riid: *const GUID, ppvsite: *mut *mut c_void) -> windows::core::Result<()> {
        unsafe {
            if !ppvsite.is_null() {
                *ppvsite = std::ptr::null_mut();
            }
            match self.site.borrow().as_ref() {
                Some(s) => s.query(riid, ppvsite).ok(),
                None => Err(E_FAIL.into()),
            }
        }
    }
}

impl IPreviewHandler_Impl for SketchorPreview_Impl {
    fn SetWindow(&self, hwnd: HWND, prc: *const RECT) -> windows::core::Result<()> {
        self.parent.set(hwnd);
        if !prc.is_null() {
            self.rect.set(unsafe { *prc });
        }
        self.resize_child();
        Ok(())
    }

    fn SetRect(&self, prc: *const RECT) -> windows::core::Result<()> {
        if !prc.is_null() {
            self.rect.set(unsafe { *prc });
        }
        self.resize_child();
        Ok(())
    }

    fn DoPreview(&self) -> windows::core::Result<()> {
        // Already showing? nothing to do.
        if !self.hwnd.get().is_invalid() {
            return Ok(());
        }
        let parent = self.parent.get();
        if parent.is_invalid() {
            return Err(E_FAIL.into());
        }
        let path = self
            .path
            .borrow()
            .clone()
            .ok_or_else(|| windows::core::Error::from(E_UNEXPECTED))?;
        let text = std::fs::read_to_string(&path).map_err(|_| E_FAIL)?;
        let shapes: Box<Vec<Shape>> = Box::new(crate::model::parse(&text));

        let class = ensure_class();
        let rc = self.rect.get();
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(class.as_ptr()),
                PCWSTR::null(),
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
                rc.left,
                rc.top,
                rc.right - rc.left,
                rc.bottom - rc.top,
                parent,
                HMENU::default(),
                hinstance(),
                None,
            )
        }
        .map_err(|_| windows::core::Error::from(E_FAIL))?;

        // Hand the parsed shapes to the window; freed on WM_NCDESTROY.
        let ptr = Box::into_raw(shapes);
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, ptr as isize) };
        self.hwnd.set(hwnd);
        Ok(())
    }

    fn Unload(&self) -> windows::core::Result<()> {
        let hwnd = self.hwnd.get();
        if !hwnd.is_invalid() {
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            self.hwnd.set(HWND::default());
        }
        *self.path.borrow_mut() = None;
        Ok(())
    }

    fn SetFocus(&self) -> windows::core::Result<()> {
        let hwnd = self.hwnd.get();
        if hwnd.is_invalid() {
            return Err(S_FALSE.into());
        }
        unsafe {
            let _ = SetFocus(hwnd);
        }
        Ok(())
    }

    fn QueryFocus(&self) -> windows::core::Result<HWND> {
        let hwnd = unsafe { GetFocus() };
        if hwnd.is_invalid() {
            Err(E_FAIL.into())
        } else {
            Ok(hwnd)
        }
    }

    fn TranslateAccelerator(&self, _pmsg: *const MSG) -> windows::core::Result<()> {
        // We host no accelerators; let the host process the message.
        Err(S_FALSE.into())
    }
}

/* --------------------------- host window ---------------------------- */

static CLASS_REGISTERED: Once = Once::new();

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Register the host window class once per process and return its name.
fn ensure_class() -> Vec<u16> {
    let name = wide(CLASS_NAME);
    CLASS_REGISTERED.call_once(|| unsafe {
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: HBRUSH::default(), // we paint the whole client area
            lpszClassName: PCWSTR(name.as_ptr()),
            ..Default::default()
        };
        RegisterClassW(&wc);
    });
    name
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ERASEBKGND => LRESULT(1), // avoid flicker; WM_PAINT fills everything
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);
            let w = rc.right - rc.left;
            let h = rc.bottom - rc.top;
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Vec<Shape>;
            if !ptr.is_null() && w > 0 && h > 0 {
                let shapes = &*ptr;
                let stroke = (w.min(h) / 200).max(1);
                render::paint(dc, shapes, w, h, stroke);
            } else if w > 0 && h > 0 {
                let brush = CreateSolidBrush(COLORREF(30 | (31 << 8) | (34 << 16)));
                let _ = windows::Win32::Graphics::Gdi::FillRect(dc, &rc, brush);
                let _ = windows::Win32::Graphics::Gdi::DeleteObject(brush);
            }
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_NCDESTROY => {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Vec<Shape>;
            if !ptr.is_null() {
                drop(Box::from_raw(ptr));
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
