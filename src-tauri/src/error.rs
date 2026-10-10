use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("PTY creation failed: {0}")]
    PtyCreationFailed(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Invalid session state: {0}")]
    InvalidState(String),

    #[error("Write failed: {0}")]
    WriteFailed(String),

    #[error("IO Error: {0}")]
    IoError(String),

    #[error("Shell executable not found: {0}")]
    ShellNotFound(String),

    #[error("Invalid working directory: {0}")]
    InvalidDirectory(String),
}

impl Serialize for TerminalError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
