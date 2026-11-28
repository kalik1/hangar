package guestinfo

import (
	"bytes"
	"encoding/json"
	"strings"
)

// decode reads an agent reply into one of v1alpha1's types: the agent's
// names (host-name, supported_commands) become camelCase (hostName,
// supportedCommands), the API's names. Numbers keep their precision: a
// 64-bit counter does not go through a float.
func decode(raw json.RawMessage, out any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return err
	}
	b, err := json.Marshal(camelize(v))
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

func camelize(v any) any {
	switch t := v.(type) {
	case map[string]any:
		m := make(map[string]any, len(t))
		for k, x := range t {
			m[camel(k)] = camelize(x)
		}
		return m
	case []any:
		for i := range t {
			t[i] = camelize(t[i])
		}
		return t
	}
	return v
}

// camel turns "ip-address-type" into "ipAddressType".
func camel(k string) string {
	if !strings.ContainsAny(k, "-_") {
		return k
	}
	var b strings.Builder
	upper := false
	for _, r := range k {
		switch {
		case r == '-' || r == '_':
			upper = b.Len() > 0
		case upper:
			b.WriteString(strings.ToUpper(string(r)))
			upper = false
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
