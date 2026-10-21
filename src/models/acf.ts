// Normalized ACF field model. See spec "ACF parsing".

export interface AcfField {
  /** Field machine name, e.g. "hero_heading". */
  name: string;
  /** Human label from ACF JSON, if present. */
  label?: string;
  /** ACF field type: text, group, repeater, flexible_content, link, image, ... */
  type: string;
  /** ACF field key, e.g. "field_abc123". */
  key?: string;
  /** Name of the parent field (for nested sub fields), if any. */
  parent?: string;
  /** Title of the owning ACF field group, e.g. "Home Page". */
  group?: string;
  /** ACF `return_format` (image, link, select, post_object, ...); ACF's default when absent. */
  returnFormat?: string;
  /** Select / post_object / user / page_link set to allow several values. */
  multiple?: boolean;
  /** Taxonomy field appearance: checkbox, multi_select, radio or select. */
  fieldType?: string;
  /** ACF JSON file the field is defined in. */
  file?: string;
  /** Sub fields for group / repeater fields. */
  subFields?: AcfField[];
  /** Layouts for flexible_content fields. */
  layouts?: AcfLayout[];
  /** Clone fields: the field and field group keys they clone. */
  clone?: string[];
  /** Clone fields: `seamless` (fields sit beside the clone) or `group` (a group under its name). */
  cloneDisplay?: string;
  /** Clone fields: the cloned fields' names are prefixed with the clone's name. */
  prefixName?: boolean;
  /** Clone fields: the fields cloned, prefixed when prefixName; linked by AcfIndex. */
  cloned?: AcfField[];
}

export interface AcfLayout {
  name: string;
  label?: string;
  subFields: AcfField[];
}

export interface AcfFieldGroup {
  title: string;
  /** Field group key, e.g. "group_abc123", which clone fields refer to. */
  key?: string;
  /** Shown on an ACF options page, so read with get_field(..., 'option'). */
  isOptions?: boolean;
  fields: AcfField[];
}
