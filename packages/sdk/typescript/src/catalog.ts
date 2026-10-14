import type { JsonObject, JsonValue } from "./types.js";

export interface DataBinding { path: string }
export interface FunctionCall { call: string; args: JsonObject; returnType: "string" | "number" | "boolean" | "array" | "object" | "any" | "void" }
export type DynamicString = string | DataBinding | FunctionCall;
export type DynamicNumber = number | DataBinding | FunctionCall;
export type DynamicBoolean = boolean | DataBinding | FunctionCall;
export type DynamicStringList = string[] | DataBinding | FunctionCall;
export type DynamicValue = string | number | boolean | JsonValue[] | DataBinding | FunctionCall;
export interface Accessibility { label?: DynamicString; description?: DynamicString }
export interface CheckRule { condition: DynamicBoolean; message: string }
export interface Checkable { checks?: CheckRule[]; isValid?: boolean; validationErrors?: string[] }
export interface EventAction { event: { name: string; context?: Record<string, DynamicValue> } }
export interface FunctionAction { functionCall: FunctionCall }
export type WireAction = EventAction | FunctionAction;

export interface CommonProps { accessibility?: Accessibility; weight?: number }
export interface TextProps extends CommonProps { text: DynamicString; variant?: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body" }
export interface ImageProps extends CommonProps { url: DynamicString; description?: DynamicString; fit?: "contain" | "cover" | "fill" | "none" | "scaleDown"; variant?: "icon" | "avatar" | "smallFeature" | "mediumFeature" | "largeFeature" | "header" }
export type IconName = "accountCircle" | "add" | "arrowBack" | "arrowForward" | "attachFile" | "calendarToday" | "call" | "camera" | "check" | "close" | "delete" | "download" | "edit" | "event" | "error" | "fastForward" | "favorite" | "favoriteOff" | "folder" | "help" | "home" | "info" | "locationOn" | "lock" | "lockOpen" | "mail" | "menu" | "moreVert" | "moreHoriz" | "notificationsOff" | "notifications" | "pause" | "payment" | "person" | "phone" | "photo" | "play" | "print" | "refresh" | "rewind" | "search" | "send" | "settings" | "share" | "shoppingCart" | "skipNext" | "skipPrevious" | "star" | "starHalf" | "starOff" | "stop" | "upload" | "visibility" | "visibilityOff" | "volumeDown" | "volumeMute" | "volumeOff" | "volumeUp" | "warning";
export interface IconProps extends CommonProps { name: IconName | { svgPath: string } | { path: string } }
export interface VideoProps extends CommonProps { url: DynamicString }
export interface AudioPlayerProps extends CommonProps { url: DynamicString; description?: DynamicString }
export interface LayoutProps extends CommonProps { children: string[]; justify?: "center" | "end" | "spaceAround" | "spaceBetween" | "spaceEvenly" | "start" | "stretch"; align?: "start" | "center" | "end" | "stretch" }
export interface ListProps extends CommonProps { children: string[] | { componentId: string; path: string }; direction?: "vertical" | "horizontal"; align?: "start" | "center" | "end" | "stretch"; listStyle?: "ordered" | "unordered" | "none" }
export interface CardProps extends CommonProps { child: string }
export interface TabsProps extends CommonProps { tabs: Array<{ title: DynamicString; child: string }> }
export interface ModalProps extends CommonProps { trigger: string; content: string }
export interface DividerProps extends CommonProps { axis?: "horizontal" | "vertical" }
export interface ButtonProps extends CommonProps, Checkable { child: string; variant?: "default" | "primary" | "borderless"; action?: WireAction }
export interface TextFieldProps extends CommonProps, Checkable { label: DynamicString; value?: DynamicString; variant?: "longText" | "number" | "shortText" | "obscured"; validationRegexp?: string }
export interface CheckBoxProps extends CommonProps, Checkable { label: DynamicString; value: DynamicBoolean }
export interface ChoicePickerProps extends CommonProps, Checkable { label?: DynamicString; variant?: "multipleSelection" | "mutuallyExclusive"; options: Array<{ label: DynamicString; value: string }>; value: DynamicStringList; displayStyle?: "checkbox" | "chips"; filterable?: boolean }
export interface SliderProps extends CommonProps, Checkable { label?: DynamicString; min?: number; max: number; value: DynamicNumber }
export interface DateTimeInputProps extends CommonProps, Checkable { value: DynamicString; enableDate?: boolean; enableTime?: boolean; min?: DynamicString; max?: DynamicString; label?: DynamicString }

export interface BasicComponentMap {
  Text: TextProps; Image: ImageProps; Icon: IconProps; Video: VideoProps; AudioPlayer: AudioPlayerProps;
  Row: LayoutProps; Column: LayoutProps; List: ListProps; Card: CardProps; Tabs: TabsProps; Modal: ModalProps;
  Divider: DividerProps; Button: ButtonProps; TextField: TextFieldProps; CheckBox: CheckBoxProps;
  ChoicePicker: ChoicePickerProps; Slider: SliderProps; DateTimeInput: DateTimeInputProps;
}

export type ComponentMap = object;
export interface CatalogDefinition<Components extends ComponentMap> { readonly id: string; readonly name: string }
export const BASIC_CATALOG: CatalogDefinition<BasicComponentMap> = {
  id: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
  name: "BasicCatalog",
};
