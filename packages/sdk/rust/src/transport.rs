use std::collections::BTreeSet;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines, Stdin, Stdout};

use crate::Result;

#[async_trait]
pub trait Transport: Send {
    fn capabilities(&self) -> BTreeSet<String> {
        BTreeSet::new()
    }
    async fn send(&mut self, message: &Value) -> Result<()>;
    async fn receive(&mut self) -> Result<Option<Value>>;
}

pub struct StdioTransport {
    lines: Lines<BufReader<Stdin>>,
    stdout: Stdout,
    capabilities: BTreeSet<String>,
}

impl StdioTransport {
    pub fn new() -> Self {
        Self::with_capabilities(Vec::<String>::new())
    }
    pub fn with_capabilities(capabilities: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            lines: BufReader::new(tokio::io::stdin()).lines(),
            stdout: tokio::io::stdout(),
            capabilities: capabilities.into_iter().map(Into::into).collect(),
        }
    }
}

impl Default for StdioTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Transport for StdioTransport {
    fn capabilities(&self) -> BTreeSet<String> {
        self.capabilities.clone()
    }
    async fn send(&mut self, message: &Value) -> Result<()> {
        self.stdout
            .write_all(serde_json::to_string(message)?.as_bytes())
            .await?;
        self.stdout.write_all(b"\n").await?;
        self.stdout.flush().await?;
        Ok(())
    }
    async fn receive(&mut self) -> Result<Option<Value>> {
        loop {
            let Some(line) = self.lines.next_line().await? else {
                return Ok(None);
            };
            if !line.trim().is_empty() {
                return Ok(Some(serde_json::from_str(&line)?));
            }
        }
    }
}

pub struct CallbackTransport<S, R> {
    sender: S,
    receiver: R,
    capabilities: BTreeSet<String>,
}

impl<S, R> CallbackTransport<S, R> {
    pub fn new(sender: S, receiver: R) -> Self {
        Self {
            sender,
            receiver,
            capabilities: BTreeSet::new(),
        }
    }
    pub fn with_capabilities(
        mut self,
        capabilities: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.capabilities = capabilities.into_iter().map(Into::into).collect();
        self
    }
}

#[async_trait]
impl<S, R, SF, RF> Transport for CallbackTransport<S, R>
where
    S: FnMut(Value) -> SF + Send,
    R: FnMut() -> RF + Send,
    SF: std::future::Future<Output = Result<()>> + Send,
    RF: std::future::Future<Output = Result<Option<Value>>> + Send,
{
    fn capabilities(&self) -> BTreeSet<String> {
        self.capabilities.clone()
    }
    async fn send(&mut self, message: &Value) -> Result<()> {
        (self.sender)(message.clone()).await
    }
    async fn receive(&mut self) -> Result<Option<Value>> {
        (self.receiver)().await
    }
}
