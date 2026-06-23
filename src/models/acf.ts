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
  /** Sub fields for group / repeater fields. */
  subFields?: AcfField[];
  /** Layouts for flexible_content fields. */
  layouts?: AcfLayout[];
}

export interface AcfLayout {
  name: string;
  label?: string;
  subFields: AcfField[];
}

export interface AcfFieldGroup {
  title: string;
  fields: AcfField[];
}
