#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("declaration error: {0}")]
    Declaration(String),
    #[error("renderer lacks required capabilities: {0}")]
    Capability(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("transport error: {0}")]
    Transport(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
