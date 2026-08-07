import { Input, Output } from "@julusian/midi";

import { assertConfigurationWrite, assertReadOnlyRequest, isIdentityResponse, UNIVERSAL_IDENTITY_REQUEST } from "./protocol.js";
import type { DeviceDescriptor } from "./model.js";
import { parseIdentityResponse } from "./protocol.js";

export type MessageHandler = (message: number[]) => void;

export interface MidiConnection {
  send(message: ArrayLike<number>): void;
  subscribe(handler: MessageHandler): () => void;
  close(): void;
}

export interface ConfigurationWriteConnection extends MidiConnection {
  sendConfigurationWrite(message: ArrayLike<number>): void;
}

export interface MidiBackend {
  discover(timeoutMs: number): Promise<DeviceDescriptor[]>;
  connect(device: DeviceDescriptor): MidiConnection;
  connectForApply(device: DeviceDescriptor): ConfigurationWriteConnection;
}

/**
 * Permits either a read-only request or a configuration write. This is the guard used
 * by {@link RtMidiApplyConnection}'s transport, which itself already applies the exact
 * same checks before calling down to this layer (so the check here is redundant, i.e.
 * idempotent, on that path) -- it exists so that if a future edit ever constructs
 * `RtMidiPorts` directly, or adds a call site that bypasses the wrapper classes, the
 * innermost layer still refuses to send an arbitrary/mutating message.
 */
function assertApplyRequest(message: ArrayLike<number>): void {
  try {
    assertReadOnlyRequest(message);
    return;
  } catch {
    // fall through to the broader (write-permitting) check
  }
  assertConfigurationWrite(message);
}

class RtMidiPorts implements MidiConnection {
  private readonly input = new Input();
  private readonly output = new Output();
  private readonly handlers = new Set<MessageHandler>();

  /**
   * `guard` runs on every outbound message before it reaches the MIDI output, so this
   * class is safe by default even if constructed outside the guarded wrapper classes
   * below. It defaults to read-only; {@link RtMidiApplyConnection} passes the broader
   * {@link assertApplyRequest} explicitly, since it is the one surface allowed to write.
   */
  constructor(
    inputPort: number,
    outputPort: number,
    private readonly guard: (message: ArrayLike<number>) => void = assertReadOnlyRequest,
  ) {
    this.input.ignoreTypes(false, true, true);
    this.input.on("message", (_deltaTime: number, message: number[]) => {
      for (const handler of this.handlers) handler([...message]);
    });
    this.input.openPort(inputPort);
    this.output.openPort(outputPort);
  }

  send(message: ArrayLike<number>): void {
    this.guard(message);
    this.output.sendMessage(Array.from(message));
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.handlers.clear();
    this.input.closePort();
    this.output.closePort();
  }
}

/** Guarded connection used by every read-only host surface. */
export class ReadOnlyMidiConnection implements MidiConnection {
  constructor(private readonly transport: MidiConnection) {}

  send(message: ArrayLike<number>): void {
    assertReadOnlyRequest(message);
    this.transport.send(message);
  }

  subscribe(handler: MessageHandler): () => void {
    return this.transport.subscribe(handler);
  }

  close(): void {
    this.transport.close();
  }
}

class RtMidiApplyConnection implements ConfigurationWriteConnection {
  private readonly transport: MidiConnection;

  constructor(inputPort: number, outputPort: number) {
    this.transport = new RtMidiPorts(inputPort, outputPort, assertApplyRequest);
  }

  send(message: ArrayLike<number>): void {
    assertReadOnlyRequest(message);
    this.transport.send(message);
  }

  sendConfigurationWrite(message: ArrayLike<number>): void {
    assertConfigurationWrite(message);
    this.transport.send(message);
  }

  subscribe(handler: MessageHandler): () => void {
    return this.transport.subscribe(handler);
  }

  close(): void {
    this.transport.close();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Probe every MIDI output while listening on every input. This does not rely on
 * port names, which vary across CoreMIDI, ALSA, and Windows MIDI services.
 */
async function discoverTwisters(timeoutMs = 350): Promise<DeviceDescriptor[]> {
    const inputEnumerator = new Input();
    const outputEnumerator = new Output();
    const inputPorts = Array.from({ length: inputEnumerator.getPortCount() }, (_, index) => ({
      index,
      name: inputEnumerator.getPortName(index),
    }));
    const outputPorts = Array.from({ length: outputEnumerator.getPortCount() }, (_, index) => ({
      index,
      name: outputEnumerator.getPortName(index),
    }));
    inputEnumerator.closePort();
    outputEnumerator.closePort();

    const received: Array<{ inputIndex: number; message: number[] }> = [];
    const inputs = inputPorts.map((port) => {
      const input = new Input();
      input.ignoreTypes(false, true, true);
      input.on("message", (_deltaTime: number, message: number[]) => {
        received.push({ inputIndex: port.index, message: [...message] });
      });
      input.openPort(port.index);
      return input;
    });

    const discovered: DeviceDescriptor[] = [];
    try {
      for (const outputPort of outputPorts) {
        const output = new Output();
        output.openPort(outputPort.index);
        const firstResponseIndex = received.length;
        assertReadOnlyRequest(UNIVERSAL_IDENTITY_REQUEST);
        output.sendMessage(Array.from(UNIVERSAL_IDENTITY_REQUEST));
        await delay(timeoutMs);
        output.closePort();

        for (const response of received.slice(firstResponseIndex).filter((entry) => isIdentityResponse(entry.message))) {
          const inputPort = inputPorts.find((port) => port.index === response.inputIndex)!;
          discovered.push({
            inputPort,
            outputPort,
            identity: parseIdentityResponse(response.message),
          });
        }
      }
    } finally {
      for (const input of inputs) input.closePort();
    }

    const unique = new Map<string, DeviceDescriptor>();
    for (const device of discovered) {
      unique.set(`${device.inputPort.index}:${device.outputPort.index}`, device);
    }
  return [...unique.values()];
}

export class RtMidiBackend implements MidiBackend {
  discover(timeoutMs = 350): Promise<DeviceDescriptor[]> {
    return discoverTwisters(timeoutMs);
  }

  connect(device: DeviceDescriptor): MidiConnection {
    return new ReadOnlyMidiConnection(new RtMidiPorts(device.inputPort.index, device.outputPort.index));
  }


  connectForApply(device: DeviceDescriptor): ConfigurationWriteConnection {
    return new RtMidiApplyConnection(device.inputPort.index, device.outputPort.index);
  }
}

/**
 * Backend exposed to read-only surfaces. Its public API cannot construct the
 * separate apply connection, so a UI route cannot accidentally gain writes.
 */
export class RtMidiReadOnlyBackend implements Pick<MidiBackend, "discover" | "connect"> {
  discover(timeoutMs: number): Promise<DeviceDescriptor[]> {
    return discoverTwisters(timeoutMs);
  }

  connect(device: DeviceDescriptor): MidiConnection {
    return new ReadOnlyMidiConnection(new RtMidiPorts(device.inputPort.index, device.outputPort.index));
  }
}
