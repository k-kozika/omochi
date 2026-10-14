from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, Literal, Required, TypeVar, TypedDict

DataBinding = TypedDict("DataBinding", {"path": str})
FunctionCall = TypedDict("FunctionCall", {"call": str, "args": dict[str, Any], "returnType": str})
DynamicString = str | DataBinding | FunctionCall
DynamicNumber = float | DataBinding | FunctionCall
DynamicBoolean = bool | DataBinding | FunctionCall
DynamicStringList = list[str] | DataBinding | FunctionCall

class CommonProps(TypedDict, total=False):
    accessibility: dict[str, DynamicString]
    weight: float

class TextProps(CommonProps, total=False):
    text: Required[DynamicString]
    variant: Literal["h1", "h2", "h3", "h4", "h5", "caption", "body"]

class ImageProps(CommonProps, total=False):
    url: Required[DynamicString]
    description: DynamicString
    fit: Literal["contain", "cover", "fill", "none", "scaleDown"]
    variant: Literal["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"]

class IconProps(CommonProps, total=False):
    name: Required[str | dict[str, str]]

class MediaProps(CommonProps, total=False):
    url: Required[DynamicString]
    description: DynamicString

class LayoutProps(CommonProps, total=False):
    children: Required[list[str]]
    justify: Literal["center", "end", "spaceAround", "spaceBetween", "spaceEvenly", "start", "stretch"]
    align: Literal["start", "center", "end", "stretch"]

class ListProps(CommonProps, total=False):
    children: Required[list[str] | dict[str, str]]
    direction: Literal["vertical", "horizontal"]
    align: Literal["start", "center", "end", "stretch"]
    listStyle: Literal["ordered", "unordered", "none"]

class CardProps(CommonProps):
    child: str

class TabsProps(CommonProps):
    tabs: list[dict[str, Any]]

class ModalProps(CommonProps):
    trigger: str
    content: str

class DividerProps(CommonProps, total=False):
    axis: Literal["horizontal", "vertical"]

class ButtonProps(CommonProps, total=False):
    child: Required[str]
    variant: Literal["default", "primary", "borderless"]
    action: dict[str, Any]
    checks: list[dict[str, Any]]
    isValid: bool
    validationErrors: list[str]

class TextFieldProps(CommonProps, total=False):
    label: Required[DynamicString]
    value: DynamicString
    variant: Literal["longText", "number", "shortText", "obscured"]
    validationRegexp: str
    checks: list[dict[str, Any]]
    isValid: bool
    validationErrors: list[str]

class CheckBoxProps(CommonProps, total=False):
    label: Required[DynamicString]
    value: Required[DynamicBoolean]

class ChoicePickerProps(CommonProps, total=False):
    label: DynamicString
    variant: Literal["multipleSelection", "mutuallyExclusive"]
    options: Required[list[dict[str, Any]]]
    value: Required[DynamicStringList]
    displayStyle: Literal["checkbox", "chips"]
    filterable: bool

class SliderProps(CommonProps, total=False):
    label: DynamicString
    min: float
    max: Required[float]
    value: Required[DynamicNumber]

class DateTimeInputProps(CommonProps, total=False):
    value: Required[DynamicString]
    enableDate: bool
    enableTime: bool
    min: DynamicString
    max: DynamicString
    label: DynamicString

class TextOptions(CommonProps, total=False):
    variant: Literal["h1", "h2", "h3", "h4", "h5", "caption", "body"]

class ImageOptions(CommonProps, total=False):
    description: DynamicString
    fit: Literal["contain", "cover", "fill", "none", "scaleDown"]
    variant: Literal["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"]

class MediaOptions(CommonProps, total=False):
    description: DynamicString

class LayoutOptions(CommonProps, total=False):
    justify: Literal["center", "end", "spaceAround", "spaceBetween", "spaceEvenly", "start", "stretch"]
    align: Literal["start", "center", "end", "stretch"]

class ListOptions(CommonProps, total=False):
    direction: Literal["vertical", "horizontal"]
    align: Literal["start", "center", "end", "stretch"]
    listStyle: Literal["ordered", "unordered", "none"]

class ButtonOptions(CommonProps, total=False):
    variant: Literal["default", "primary", "borderless"]
    checks: list[dict[str, Any]]
    isValid: bool
    validationErrors: list[str]

class TextFieldOptions(CommonProps, total=False):
    variant: Literal["longText", "number", "shortText", "obscured"]
    validationRegexp: str
    checks: list[dict[str, Any]]
    isValid: bool
    validationErrors: list[str]

class CheckableOptions(CommonProps, total=False):
    checks: list[dict[str, Any]]
    isValid: bool
    validationErrors: list[str]

class ChoicePickerOptions(CheckableOptions, total=False):
    label: DynamicString
    variant: Literal["multipleSelection", "mutuallyExclusive"]
    displayStyle: Literal["checkbox", "chips"]
    filterable: bool

class SliderOptions(CheckableOptions, total=False):
    label: DynamicString

class DateTimeInputOptions(CheckableOptions, total=False):
    enableDate: bool
    enableTime: bool
    min: DynamicString
    max: DynamicString
    label: DynamicString

UIType = TypeVar("UIType")

@dataclass(frozen=True, slots=True)
class Catalog(Generic[UIType]):
    id: str
    name: str
    ui_type: type[UIType] | None = None

BASIC_CATALOG: Catalog[Any] = Catalog(
    id="https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
    name="BasicCatalog",
)
