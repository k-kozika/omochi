use serde::Serialize;
use serde_json::{Map, Value};

use crate::JsonObject;

pub trait ComponentProps {
    const NAME: &'static str;
    fn into_props(self) -> JsonObject;
}

fn object<T: Serialize>(value: T) -> JsonObject {
    let mut value = serde_json::to_value(value)
        .unwrap()
        .as_object()
        .unwrap()
        .clone();
    value.retain(|_, value| !value.is_null());
    value
}

macro_rules! component {
    ($name:ident, $wire:literal, { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Default, Serialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            $(pub $field: $ty,)*
            #[serde(skip_serializing_if = "Option::is_none")]
            pub accessibility: Option<Map<String, Value>>,
            #[serde(skip_serializing_if = "Option::is_none")]
            pub weight: Option<f64>,
        }
        impl ComponentProps for $name {
            const NAME: &'static str = $wire;
            fn into_props(self) -> JsonObject { object(self) }
        }
    };
}

component!(TextProps, "Text", { text: Value, variant: Option<String> });
component!(ImageProps, "Image", { url: Value, description: Option<Value>, fit: Option<String>, variant: Option<String> });
component!(IconProps, "Icon", { name: Value });
component!(VideoProps, "Video", { url: Value });
component!(AudioPlayerProps, "AudioPlayer", { url: Value, description: Option<Value> });
component!(RowProps, "Row", { children: Vec<String>, justify: Option<String>, align: Option<String> });
component!(ColumnProps, "Column", { children: Vec<String>, justify: Option<String>, align: Option<String> });
component!(ListProps, "List", { children: Value, direction: Option<String>, align: Option<String>, list_style: Option<String> });
component!(CardProps, "Card", { child: String });
component!(TabsProps, "Tabs", { tabs: Vec<Value> });
component!(ModalProps, "Modal", { trigger: String, content: String });
component!(DividerProps, "Divider", { axis: Option<String> });
component!(ButtonProps, "Button", { child: String, variant: Option<String>, action: Option<Value> });
component!(TextFieldProps, "TextField", { label: Value, value: Option<Value>, variant: Option<String>, validation_regexp: Option<String> });
component!(CheckBoxProps, "CheckBox", { label: Value, value: Value });
component!(ChoicePickerProps, "ChoicePicker", { label: Option<Value>, variant: Option<String>, options: Vec<Value>, value: Value, display_style: Option<String>, filterable: Option<bool> });
component!(SliderProps, "Slider", { label: Option<Value>, min: Option<f64>, max: f64, value: Value });
component!(DateTimeInputProps, "DateTimeInput", { value: Value, enable_date: Option<bool>, enable_time: Option<bool>, min: Option<Value>, max: Option<Value>, label: Option<Value> });

pub struct BasicCatalog;
impl BasicCatalog {
    pub const ID: &'static str = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";
}
