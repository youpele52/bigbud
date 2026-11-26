use std::sync::atomic::{Ordering, compiler_fence};

#[cfg(test)]
type WipeObserver = Box<dyn FnOnce(&[u8]) + Send>;

/// Owns one exact-length allocation. Moving the wrapper does not copy the
/// bytes. This only wipes that allocation on drop, not source or adapter
/// copies, paging/dumps, or memory after an abrupt process termination.
pub struct PasswordBytes {
    bytes: Box<[u8]>,
    #[cfg(test)]
    on_wipe: Option<WipeObserver>,
}

impl PasswordBytes {
    /// Adopt an existing buffer; do not resize or clone it in the lifecycle.
    /// The caller is responsible for how the original allocation was filled.
    #[must_use]
    pub fn from_boxed_slice(bytes: Box<[u8]>) -> Self {
        Self {
            bytes,
            #[cfg(test)]
            on_wipe: None,
        }
    }

    pub(crate) fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    #[cfg(windows)]
    pub(crate) fn as_mut_slice(&mut self) -> &mut [u8] {
        &mut self.bytes
    }

    #[cfg(test)]
    pub(crate) fn observe_wipe(&mut self, observer: impl FnOnce(&[u8]) + Send + 'static) {
        self.on_wipe = Some(Box::new(observer));
    }
}

impl Drop for PasswordBytes {
    fn drop(&mut self) {
        for byte in &mut self.bytes {
            // SAFETY: Each pointer comes from a unique mutable reference to
            // an initialized byte in the still-owned allocation. Zero is a
            // valid u8 and the volatile store cannot be optimized away.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
        #[cfg(test)]
        if let Some(observer) = self.on_wipe.take() {
            observer(&self.bytes);
        }
    }
}
