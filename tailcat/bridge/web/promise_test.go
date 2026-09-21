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
			type outcome struct {
				rejected bool
				value    string
			}
			settled := make(chan outcome, 1)
			resolved := js.FuncOf(func(_ js.Value, args []js.Value) any {
				settled <- outcome{value: args[0].String()}
				return nil
			})
			defer resolved.Release()
			rejected := js.FuncOf(func(_ js.Value, args []js.Value) any {
				settled <- outcome{rejected: true, value: args[0].Get("message").String()}
				return nil
			})
			defer rejected.Release()
			promise.Call("then", resolved, rejected)
			// makePromise has returned and released the executor before work starts.
			close(gate)
			select {
			case got := <-settled:
				want := "deferred success"
				if reject {
					want = "deferred failure"
				}
				if got.rejected != reject || got.value != want {
					t.Fatalf("settled as %+v, want rejected=%t value=%q", got, reject, want)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("promise did not settle")
			}
		})
	}
}
