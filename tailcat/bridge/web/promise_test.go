//go:build js && wasm

package main

import (
	"errors"
	"syscall/js"
	"testing"
	"time"
)

func TestPromiseSettlesAfterExecutorReturns(t *testing.T) {
	for _, reject := range []bool{false, true} {
		name := "resolve"
		if reject {
			name = "reject"
		}
		t.Run(name, func(t *testing.T) {
			gate := make(chan struct{})
			promise := makePromise(func() (any, error) {
				<-gate
				if reject {
					return nil, errors.New("deferred failure")
				}
				return "deferred success", nil
			})
			// makePromise has returned and released the executor before work starts.
			close(gate)
			got, rejected := awaitJSPromise(t, promise)
			value, want := got.String(), "deferred success"
			if reject {
				value, want = got.Get("message").String(), "deferred failure"
			}
			if rejected != reject || value != want {
				t.Fatalf("settled as rejected=%t value=%q, want rejected=%t value=%q", rejected, value, reject, want)
			}
		})
	}
}

func awaitJSPromise(t *testing.T, promise js.Value) (js.Value, bool) {
	t.Helper()
	type outcome struct {
		value    js.Value
		rejected bool
	}
	done := make(chan outcome, 1)
	resolve := js.FuncOf(func(_ js.Value, args []js.Value) any {
		done <- outcome{value: args[0]}
		return nil
	})
	defer resolve.Release()
	reject := js.FuncOf(func(_ js.Value, args []js.Value) any {
		done <- outcome{value: args[0], rejected: true}
		return nil
	})
	defer reject.Release()
	promise.Call("then", resolve, reject)
	select {
	case result := <-done:
		return result.value, result.rejected
	case <-time.After(5 * time.Second):
		t.Fatal("JavaScript Promise did not settle")
		return js.Undefined(), true
	}
}

func requireJSResolved(t *testing.T, promise js.Value) js.Value {
	t.Helper()
	value, rejected := awaitJSPromise(t, promise)
	if rejected {
		t.Fatalf("JavaScript Promise rejected: %s", value.Get("message").String())
	}
	return value
}
