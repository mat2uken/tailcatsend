use qrcode::{Color, QrCode};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum QrError {
    #[error("QR encoding error: {0}")]
    Qr(#[from] qrcode::types::QrError),
}

pub struct QrRgbaImage {
    pub width: u32,
    pub height: u32,
    pub rgba_pixels: Vec<u8>,
}

pub fn generate_qr_rgba(url: &str, target_size_px: u32) -> Result<QrRgbaImage, QrError> {
    let code = QrCode::new(url.as_bytes())?;
    let qr_size = code.width(); // number of modules per side
    let quiet_zone = 4;
    let total_modules = qr_size + quiet_zone * 2;

    let scale = target_size_px.div_ceil(total_modules as u32);
    let scale = scale.max(1);
    let final_size = (total_modules as u32) * scale;

    let mut rgba_pixels = vec![255u8; (final_size * final_size * 4) as usize];

    let dark_r = 0x1a;
    let dark_g = 0x1a;
    let dark_b = 0x1a;
    let dark_a = 0xff;

    let light_r = 0xff;
    let light_g = 0xff;
    let light_b = 0xff;
    let light_a = 0xff;

    let colors = code.to_colors();

    for y in 0..final_size {
        let mod_y = (y / scale) as i32 - quiet_zone as i32;
        for x in 0..final_size {
            let mod_x = (x / scale) as i32 - quiet_zone as i32;

            let is_dark =
                if mod_x >= 0 && mod_x < qr_size as i32 && mod_y >= 0 && mod_y < qr_size as i32 {
                    let idx = (mod_y as usize) * qr_size + (mod_x as usize);
                    colors[idx] == Color::Dark
                } else {
                    false
                };

            let pixel_offset = ((y * final_size + x) * 4) as usize;
            if is_dark {
                rgba_pixels[pixel_offset] = dark_r;
                rgba_pixels[pixel_offset + 1] = dark_g;
                rgba_pixels[pixel_offset + 2] = dark_b;
                rgba_pixels[pixel_offset + 3] = dark_a;
            } else {
                rgba_pixels[pixel_offset] = light_r;
                rgba_pixels[pixel_offset + 1] = light_g;
                rgba_pixels[pixel_offset + 2] = light_b;
                rgba_pixels[pixel_offset + 3] = light_a;
            }
        }
    }

    Ok(QrRgbaImage {
        width: final_size,
        height: final_size,
        rgba_pixels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_qr_generation() {
        let result = generate_qr_rgba("https://tailsend.example.com/#i=test", 300).unwrap();
        assert!(result.width >= 300);
        assert!(result.height >= 300);
        assert_eq!(
            result.rgba_pixels.len(),
            (result.width * result.height * 4) as usize
        );
        // Ensure quiet zone top-left pixel is light
        assert_eq!(result.rgba_pixels[0], 255);
        assert_eq!(result.rgba_pixels[1], 255);
        assert_eq!(result.rgba_pixels[2], 255);
        assert_eq!(result.rgba_pixels[3], 255);
    }
}
