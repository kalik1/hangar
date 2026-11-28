package app_test

import (
	"flag"
	"os"
	"testing"

	"k8s.io/klog/v2"
)

// HANGAR_TEST_V sets the bridges' log verbosity, as -v would: 3 logs every
// request.
func TestMain(m *testing.M) {
	if v := os.Getenv("HANGAR_TEST_V"); v != "" {
		fs := flag.NewFlagSet("klog", flag.ExitOnError)
		klog.InitFlags(fs)
		_ = fs.Set("v", v)
	}
	os.Exit(m.Run())
}
