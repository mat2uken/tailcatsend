use std::collections::HashSet;
use thiserror::Error;

use crate::limits::MAX_FILENAME_BYTES;

#[derive(Debug, Error)]
pub enum FilenameError {
    #[error("Filename is empty or only whitespace")]
    EmptyFilename,
    #[error("Filename contains invalid characters (NUL or path separators)")]
    InvalidCharacters,
    #[error("Filename is a reserved name")]
    ReservedName,
    #[error("Filename byte length exceeds maximum ({0} > {MAX_FILENAME_BYTES})")]
    FilenameTooLong(usize),
}

pub fn sanitize_filename(raw_name: &str) -> Result<String, FilenameError> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return Ok("unnamed_file".to_string());
    }

    // Strip any leading drive letters (e.g. C:)
    let without_drive = if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
        &trimmed[2..]
    } else {
        trimmed
    };

    // Extract basename using both forward and backward slashes
    let basename = without_drive
        .split(|c| c == '/' || c == '\\')
        .filter(|s| !s.is_empty())
        .last()
        .unwrap_or(without_drive);

    if basename == "." || basename == ".." {
        return Ok("unnamed_file".to_string());
    }

    // Filter out NUL and control characters
    let mut cleaned: String = basename
        .chars()
        .filter(|c| !c.is_control() && *c != '\0')
        .collect();

    // Replace dangerous characters on Windows: < > : " / \ | ? *
    cleaned = cleaned
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            other => other,
        })
        .collect();

    let cleaned_trimmed = cleaned
        .trim_end_matches(|c: char| c == '.' || c.is_whitespace())
        .trim();

    if cleaned_trimmed.is_empty() {
        return Ok("unnamed_file".to_string());
    }

    // Check Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    let stem = cleaned_trimmed
        .split('.')
        .next()
        .unwrap_or(cleaned_trimmed)
        .to_ascii_uppercase();

    let is_reserved = matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );

    let final_name = if is_reserved {
        format!("_{}", cleaned_trimmed)
    } else {
        cleaned_trimmed.to_string()
    };

    if final_name.len() > MAX_FILENAME_BYTES {
        return Err(FilenameError::FilenameTooLong(final_name.len()));
    }

    Ok(final_name)
}

pub fn generate_unique_filename(existing_names: &HashSet<String>, candidate: &str) -> String {
    if !existing_names.contains(candidate) {
        return candidate.to_string();
    }

    let (stem, ext) = if let Some(dot_idx) = candidate.rfind('.') {
        if dot_idx == 0 {
            (candidate, "")
        } else {
            (&candidate[..dot_idx], &candidate[dot_idx..])
        }
    } else {
        (candidate, "")
    };

    let mut index = 1;
    loop {
        let candidate_name = format!("{} ({}){}", stem, index, ext);
        if !existing_names.contains(&candidate_name) {
            return candidate_name;
        }
        index += 1;
    }
}
