//! Pictures of a card's page from WebKit itself, visible or hidden.
use std::cell::RefCell;

use base64::Engine;
use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor, NSView};
use objc2_foundation::{NSDictionary, NSError, NSNumber};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
use serde_json::{json, Value};

use super::{surface::{owned, SURFACES}, Reply};

/// At Retina density JPEG keeps text readable at about a tenth of PNG's size.
const JPEG_QUALITY: f64 = 0.85;

pub(super) fn capture(input: &Value, reply: Reply) {
    let wk = SURFACES.with(|surfaces| -> Result<Retained<WKWebView>, String> {
        Ok(owned(&mut surfaces.borrow_mut(), input)?.wk.clone())
    });
    let wk = match wk {
        Ok(wk) => wk,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let jpeg = input["format"] == "jpeg";
    let css = input["scale"] == "css";
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = reply.send(Err("Browser capture must run on the main thread".into()));
        return;
    };
    let view: &NSView = &wk;
    let size = view.bounds().size;
    let backing = view.window().map(|window| window.backingScaleFactor()).unwrap_or(1.0);
    let configuration = unsafe { WKSnapshotConfiguration::new(mtm) };
    if css {
        // The snapshot width is in points and WebKit renders it at the screen's density.
        let width = NSNumber::new_f64(size.width / backing);
        unsafe { configuration.setSnapshotWidth(Some(&width)) };
    }
    let reply = RefCell::new(Some(reply));
    let taken = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let Some(reply) = reply.borrow_mut().take() else {
            return;
        };
        let encoded = encode(image, error, jpeg).map(|data| {
            json!({ "data": data, "width": size.width, "height": size.height })
        });
        let _ = reply.send(encoded);
    });
    unsafe { wk.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &taken) };
}

fn encode(image: *mut NSImage, error: *mut NSError, jpeg: bool) -> Result<String, String> {
    if image.is_null() {
        return Err(if error.is_null() {
            "The browser returned no image".into()
        } else {
            unsafe { &*error }.localizedDescription().to_string()
        });
    }
    let image = unsafe { &*image };
    let tiff = image.TIFFRepresentation().ok_or("The browser image could not be read")?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("The browser image could not be read")?;
    let quality = NSNumber::new_f64(JPEG_QUALITY);
    let quality: &AnyObject = &quality;
    let properties = NSDictionary::from_slices(&[unsafe { NSImageCompressionFactor }], &[quality]);
    let kind = if jpeg { NSBitmapImageFileType::JPEG } else { NSBitmapImageFileType::PNG };
    let data = unsafe { bitmap.representationUsingType_properties(kind, &properties) }
        .ok_or("The browser image could not be encoded")?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data.to_vec()))
}
