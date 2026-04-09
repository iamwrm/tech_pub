#!/usr/bin/env bash
set -euo pipefail

# Install mise if not already installed
if ! command -v mise &> /dev/null; then
  curl -sSf https://mise.run | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# Install Erlang and Elixir via mise
mise use erlang@latest elixir@latest -y

# Activate mise
eval "$(mise activate bash)"
export ELIXIR_ERL_OPTIONS="+fnu"

# Create and run GenServer example
cat > /tmp/gen_server_example.exs << 'ELIXIR'
defmodule Counter do
  use GenServer

  def start_link(initial \\ 0), do: GenServer.start_link(__MODULE__, initial, name: __MODULE__)
  def increment, do: GenServer.call(__MODULE__, :increment)
  def decrement, do: GenServer.call(__MODULE__, :decrement)
  def get_value, do: GenServer.call(__MODULE__, :get_value)
  def reset, do: GenServer.cast(__MODULE__, :reset)

  @impl true
  def init(val) do
    IO.puts("Counter started with value: #{val}")
    {:ok, val}
  end

  @impl true
  def handle_call(:increment, _from, s), do: {:reply, s + 1, s + 1}
  def handle_call(:decrement, _from, s), do: {:reply, s - 1, s - 1}
  def handle_call(:get_value, _from, s), do: {:reply, s, s}

  @impl true
  def handle_cast(:reset, _s) do
    IO.puts("Counter reset to 0")
    {:noreply, 0}
  end
end

{:ok, _} = Counter.start_link(0)
IO.puts("Increment: #{Counter.increment()}")
IO.puts("Increment: #{Counter.increment()}")
IO.puts("Increment: #{Counter.increment()}")
IO.puts("Decrement: #{Counter.decrement()}")
IO.puts("Value: #{Counter.get_value()}")
Counter.reset()
Process.sleep(50)
IO.puts("After reset: #{Counter.get_value()}")
ELIXIR

elixir /tmp/gen_server_example.exs
