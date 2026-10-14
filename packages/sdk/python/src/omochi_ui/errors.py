class A2UIError(Exception):
    """Base error raised by the runtime."""


class CapabilityError(A2UIError):
    """Raised when a declaration requires a renderer capability."""


class DeclarationError(A2UIError):
    """Raised when a UI declaration is invalid."""


class ProtocolError(A2UIError):
    """Raised when an incoming A2UI message is invalid."""
