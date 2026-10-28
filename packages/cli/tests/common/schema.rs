use serde_json::Value;

/// Validate the JSON Schema keywords used by the emitted CLI input/error schemas.
/// Local references are resolved against the published schema resource; remote
/// references are rejected so tests never need network access.
pub fn validate(root: &Value, schema: &Value, instance: &Value) -> Result<(), String> {
    validate_at(root, schema, instance, "$")
}

fn validate_at(root: &Value, schema: &Value, instance: &Value, path: &str) -> Result<(), String> {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let pointer = reference.strip_prefix('#').ok_or_else(|| {
            format!("{path}: remote schema reference is unsupported: {reference}")
        })?;
        let target = root
            .pointer(pointer)
            .ok_or_else(|| format!("{path}: unresolved schema reference: {reference}"))?;
        validate_at(root, target, instance, path)?;
    }

    if let Some(all_of) = schema.get("allOf").and_then(Value::as_array) {
        for (index, branch) in all_of.iter().enumerate() {
            validate_at(root, branch, instance, &format!("{path}.allOf[{index}]"))?;
        }
    }
    if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array) {
        let matching = one_of
            .iter()
            .filter(|branch| validate_at(root, branch, instance, path).is_ok())
            .count();
        if matching != 1 {
            return Err(format!(
                "{path}: expected exactly one matching oneOf branch, got {matching}"
            ));
        }
    }
    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        if !any_of
            .iter()
            .any(|branch| validate_at(root, branch, instance, path).is_ok())
        {
            return Err(format!("{path}: no anyOf branch matched"));
        }
    }

    if let Some(expected) = schema.get("type") {
        let type_matches = expected.as_str().map_or_else(
            || {
                expected
                    .as_array()
                    .is_some_and(|types| types.iter().any(|kind| matches_type(kind, instance)))
            },
            |kind| matches_type(&Value::String(kind.to_owned()), instance),
        );
        if !type_matches {
            return Err(format!("{path}: instance has the wrong type"));
        }
    }
    if let Some(expected) = schema.get("const") {
        if expected != instance {
            return Err(format!("{path}: instance does not match const"));
        }
    }
    if let Some(choices) = schema.get("enum").and_then(Value::as_array) {
        if !choices.contains(instance) {
            return Err(format!("{path}: instance is not in enum"));
        }
    }

    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        // In JSON Schema, object-only keywords do not apply to other instance
        // types. The type keyword above rejects non-objects when the schema
        // requires an object, while nullable object schemas intentionally let
        // `required` apply only to their object branch.
        if let Some(object) = instance.as_object() {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    return Err(format!("{path}: missing required property {key}"));
                }
            }
        }
    }
    if let (Some(properties), Some(object)) = (
        schema.get("properties").and_then(Value::as_object),
        instance.as_object(),
    ) {
        for (key, property_schema) in properties {
            if let Some(value) = object.get(key) {
                validate_at(root, property_schema, value, &format!("{path}.{key}"))?;
            }
        }
    }
    if let Some(additional) = schema.get("additionalProperties") {
        if let Some(object) = instance.as_object() {
            let properties = schema.get("properties").and_then(Value::as_object);
            for (key, value) in object {
                if properties.is_some_and(|properties| properties.contains_key(key)) {
                    continue;
                }
                match additional {
                    Value::Bool(false) => {
                        return Err(format!("{path}: unexpected property {key}"));
                    }
                    Value::Object(_) => {
                        validate_at(root, additional, value, &format!("{path}.{key}"))?;
                    }
                    _ => {}
                }
            }
        }
    }
    if let (Some(item_schema), Some(items)) = (schema.get("items"), instance.as_array()) {
        for (index, item) in items.iter().enumerate() {
            validate_at(root, item_schema, item, &format!("{path}[{index}]"))?;
        }
    }
    if let (Some(minimum), Some(items)) = (
        schema.get("minItems").and_then(Value::as_u64),
        instance.as_array(),
    ) {
        if items.len() < minimum as usize {
            return Err(format!("{path}: array has fewer than {minimum} items"));
        }
    }
    if let (Some(minimum), Some(text)) = (
        schema.get("minLength").and_then(Value::as_u64),
        instance.as_str(),
    ) {
        if text.chars().count() < minimum as usize {
            return Err(format!("{path}: string is shorter than {minimum}"));
        }
    }
    if let (Some(maximum), Some(number)) = (
        schema.get("minimum").and_then(Value::as_f64),
        instance.as_f64(),
    ) {
        if number < maximum {
            return Err(format!("{path}: number is below minimum {maximum}"));
        }
    }
    if let (Some(maximum), Some(number)) = (
        schema.get("maximum").and_then(Value::as_f64),
        instance.as_f64(),
    ) {
        if number > maximum {
            return Err(format!("{path}: number is above maximum {maximum}"));
        }
    }
    Ok(())
}

fn matches_type(kind: &Value, instance: &Value) -> bool {
    match kind.as_str() {
        Some("object") => instance.is_object(),
        Some("array") => instance.is_array(),
        Some("string") => instance.is_string(),
        Some("integer") => {
            instance.as_i64().is_some()
                || instance.as_u64().is_some()
                || instance
                    .as_f64()
                    .is_some_and(|number| number.fract() == 0.0)
        }
        Some("number") => instance.is_number(),
        Some("boolean") => instance.is_boolean(),
        Some("null") => instance.is_null(),
        _ => false,
    }
}
