import _ from 'lodash';
import SerialPort from 'serialport';
import log from '../../lib/log';
import Feeder from '../../lib/feeder';
import Sender, { STREAMING_PROTOCOL_CHAR_COUNTING } from '../../lib/gcode-sender';
import config from '../../services/configstore';
import monitor from '../../services/monitor';
import store from '../../store';
import Grbl from './Grbl';
import Smoothie from '../Smoothie/Smoothie';
import {
    WORKFLOW_STATE_RUNNING,
    WORKFLOW_STATE_PAUSED,
    WORKFLOW_STATE_IDLE
} from '../../constants';
import {
    GRBL,
    GRBL_ACTIVE_STATE_RUN,
    GRBL_REALTIME_COMMANDS
} from './constants';
import {
    SMOOTHIE,
    SMOOTHIE_ACTIVE_STATE_HOLD
} from '../Smoothie/constants';

const noop = _.noop;

const dbg = (...args) => {
    log.raw.apply(log, ['silly'].concat(args));
};

class Connection {
    socket = null;
    sentCommand = '';

    constructor(socket) {
        this.socket = socket;
    }
}

class GrblController {
    type = GRBL;

    // Connections
    connections = [];

    // SerialPort
    options = {
        port: '',
        baudrate: 115200
    };
    serialport = null;

    // Grbl or Smoothie
    firmware = GRBL;

    // Grbl
    grbl = null;
    ready = false;
    state = {};
    queryTimer = null;
    queryResponse = {
        status: false,
        parserstate: false,
        parserstateEnd: false
    };

    // Smoothie
    smoothie = null;

    // Feeder
    feeder = null;

    // Sender
    sender = null;

    // Workflow state
    workflowState = WORKFLOW_STATE_IDLE;

    constructor(port, options) {
        const { baudrate } = { ...options };

        this.options = {
            ...this.options,
            port: port,
            baudrate: baudrate
        };

        // Feeder
        this.feeder = new Feeder();
        this.feeder.on('data', ({ socket = null, line }) => {
            if (this.isClose()) {
                log.error(`[Grbl] The serial port "${this.options.port}" is not accessible`);
                return;
            }

            line = ('' + line).trim();
            if (line.length === 0) {
                return;
            }

            if (socket) {
                socket.emit('serialport:write', line);
                const index = _.findIndex(this.connections, (c) => {
                    return c.socket === socket;
                });
                if (index >= 0) {
                    this.connections[index].sentCommand = line;
                }
            } else {
                this.emitAll('serialport:write', line);
            }

            const data = line + '\n';
            this.serialport.write(data);
            dbg(`[Grbl] > ${line}`);
        });

        // Sender
        this.sender = new Sender(STREAMING_PROTOCOL_CHAR_COUNTING, {
            // Grbl has a 127 character serial receive buffer.
            // Use a lower value to deduct the length of regular commands:
            // - parser state command ($G\n)
            // - current status command: (?)
            //
            // The amount of free space in the serial receive buffer is 125 (i.e. 127 - 2 - 1).
            bufferSize: 120
        });
        this.sender.on('gcode', (gcode = '') => {
            if (this.isClose()) {
                log.error(`[Grbl] The serial port "${this.options.port}" is not accessible`);
                return;
            }

            if (this.workflowState !== WORKFLOW_STATE_RUNNING) {
                log.error(`[Grbl] Unexpected workflow state: ${this.workflowState}`);
                return;
            }

            gcode = ('' + gcode).trim();
            if (gcode.length > 0) {
                this.serialport.write(gcode + '\n');
                dbg(`[Grbl] > ${gcode}`);
            }
        });

        // Grbl
        this.grbl = new Grbl();

        this.grbl.on('raw', noop);

        this.grbl.on('status', (res) => {
            this.queryResponse.status = false;

            this.connections.forEach((c) => {
                if (c.sentCommand.indexOf('?') === 0) {
                    c.sentCommand = '';
                    c.socket.emit('serialport:read', res.raw);
                }
            });
        });

        this.grbl.on('ok', (res) => {
            if (this.queryResponse.parserstateEnd) {
                this.connections.forEach((c) => {
                    if (c.sentCommand.indexOf('$G') === 0) {
                        c.sentCommand = '';
                        c.socket.emit('serialport:read', res.raw);
                    }
                });
                this.queryResponse.parserstateEnd = false;
                return;
            }

            // Sender
            if (this.workflowState === WORKFLOW_STATE_RUNNING) {
                this.sender.ack();
                this.sender.next();
                return;
            }

            this.emitAll('serialport:read', res.raw);

            // Feeder
            this.feeder.next();
        });

        this.grbl.on('error', (res) => {
            // Sender
            if (this.workflowState === WORKFLOW_STATE_RUNNING) {
                const line = this.sender.lines[this.sender.received];
                this.emitAll('serialport:read', `> ${line}`);
                this.emitAll('serialport:read', `error=${res.message}, line=${this.sender.received + 1}`);

                this.sender.ack();
                this.sender.next();
                return;
            }

            this.emitAll('serialport:read', res.raw);

            // Feeder
            this.feeder.next();
        });

        this.grbl.on('alarm', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        this.grbl.on('parserstate', (res) => {
            this.queryResponse.parserstate = false;
            this.queryResponse.parserstateEnd = true; // wait for ok response

            this.connections.forEach((c) => {
                if (c.sentCommand.indexOf('$G') === 0) {
                    c.socket.emit('serialport:read', res.raw);
                }
            });
        });

        this.grbl.on('parameters', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        this.grbl.on('feedback', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        this.grbl.on('settings', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        this.grbl.on('startup', (res) => {
            this.firmware = GRBL;
            this.emitAll('serialport:read', res.raw);

            // The start up message always prints upon startup, after a reset, or at program end.
            // Reset the following values when Grbl has completed re-initializing all systems.
            this.queryResponse.status = false;
            this.queryResponse.parserstate = false;
            this.queryResponse.parserstateEnd = false;
        });

        this.grbl.on('others', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        // Smoothie
        this.smoothie = new Smoothie();

        this.smoothie.on('raw', noop);
        this.smoothie.on('status', noop);
        this.smoothie.on('ok', noop);
        this.smoothie.on('error', noop);
        this.smoothie.on('alarm', noop);
        this.smoothie.on('parserstate', noop);
        this.smoothie.on('parameters', noop);
        this.smoothie.on('version', (res) => {
            this.firmware = SMOOTHIE;

            // The "serialport:read" event is already emitted by "grbl.on('others')"
            //this.emitAll('serialport:read', res.raw);
        });
        this.smoothie.on('others', noop);

        // SerialPort
        this.serialport = new SerialPort(this.options.port, {
            autoOpen: false,
            baudrate: this.options.baudrate,
            parser: SerialPort.parsers.readline('\n')
        });

        this.serialport.on('data', (data) => {
            this.grbl.parse('' + data);
            this.smoothie.parse('' + data);
            dbg(`[Grbl] < ${data}`);
        });

        this.serialport.on('disconnect', (err) => {
            if (err) {
                log.warn(`[Grbl] Disconnected from serial port "${port}":`, err);
            }

            this.close();
        });

        this.serialport.on('error', (err) => {
            if (err) {
                log.error(`[Grbl] Unexpected error while reading/writing serial port "${port}":`, err);
            }
        });

        // Timer
        const queryCurrentStatus = () => {
            this.queryResponse.status = true;
            this.serialport.write('?');
        };
        const queryParserState = _.throttle(() => {
            this.queryResponse.parserstate = true;
            this.queryResponse.parserstateEnd = false;
            this.serialport.write('$G\n');
        }, 500);
        this.queryTimer = setInterval(() => {
            if (this.isClose()) {
                // Serial port is closed
                return;
            }

            // Feeder
            if (this.feeder.peek()) {
                this.emitAll('feeder:status', {
                    'size': this.feeder.queue.length
                });
            }

            // Sender
            if (this.sender.peek()) {
                this.emitAll('sender:status', this.sender.state);
            }

            // Grbl state
            if (this.state !== this.grbl.state) {
                this.state = this.grbl.state;
                this.emitAll('Grbl:state', this.state);
            }

            // Do not send "?" and "$G" when Grbl is not ready
            if (!(this.ready)) {
                // Not ready yet
                return;
            }

            // ? - Current Status
            if (!(this.queryResponse.status)) {
                queryCurrentStatus();
            }

            // $G - Parser State
            if (!(this.queryResponse.parserstate) && !(this.queryResponse.parserstateEnd)) {
                queryParserState();
            }
        }, 250);
    }
    destroy() {
        if (this.feeder) {
            this.feeder = null;
        }

        if (this.sender) {
            this.sender = null;
        }

        if (this.queryTimer) {
            clearInterval(this.queryTimer);
            this.queryTimer = null;
        }

        if (this.grbl) {
            this.grbl.removeAllListeners();
            this.grbl = null;
        }
    }
    initController() {
        const cmds = [
            { pauseAfter: 500 },

            // Check if it is Smoothieware
            { cmd: 'version', pauseAfter: 50 }
        ];

        const sendInitCommands = (i = 0) => {
            if (i >= cmds.length) {
                this.ready = true;
                return;
            }
            const { cmd = '', pauseAfter = 0 } = { ...cmds[i] };
            if (cmd) {
                this.serialport.write(cmd + '\n');
                dbg(`[Grbl] > ${cmd}`);
            }
            setTimeout(() => {
                sendInitCommands(i + 1);
            }, pauseAfter);
        };
        sendInitCommands();
    }
    get status() {
        return {
            port: this.options.port,
            baudrate: this.options.baudrate,
            connections: _.size(this.connections),
            ready: this.ready,
            controller: {
                firmware: this.firmware,
                type: this.type,
                state: this.state
            },
            workflowState: this.workflowState,
            feeder: this.feeder.state,
            sender: this.sender.state
        };
    }
    reset() {
        this.ready = false;
        this.workflowState = WORKFLOW_STATE_IDLE;
        this.queryResponse.status = false;
        this.queryResponse.parserstate = false;
        this.queryResponse.parserstateEnd = false;
    }
    open() {
        const { port, baudrate } = this.options;

        // Assertion check
        if (this.isOpen()) {
            log.error(`[Grbl] Cannot open serial port "${port}"`);
            return;
        }

        this.serialport.open((err) => {
            if (err) {
                log.error(`[Grbl] Error opening serial port "${port}":`, err);
                this.emitAll('serialport:error', { port: port });
                return;
            }

            if (store.get('controllers["' + port + '"]')) {
                log.error(`[Grbl] Serial port "${port}" was not properly closed`);
            }

            store.set('controllers["' + port + '"]', this);

            this.emitAll('serialport:open', {
                port: port,
                baudrate: baudrate,
                controllerType: this.type,
                inuse: true
            });

            log.debug(`[Grbl] Connected to serial port "${port}"`);

            // Reset
            this.reset();

            // Unload G-code
            this.command(null, 'unload');

            // Initialize controller
            this.initController();
        });
    }
    close() {
        const { port } = this.options;

        // Assertion check
        if (this.isClose()) {
            log.error(`[Grbl] The serial port "${port}" was already closed`);
            return;
        }

        this.emitAll('serialport:close', {
            port: port,
            inuse: false
        });
        store.unset('controllers["' + port + '"]');

        this.destroy();

        this.serialport.close((err) => {
            if (err) {
                log.error(`[Grbl] Error closing serial port "${port}":`, err);
            }
        });
    }
    isOpen() {
        return this.serialport.isOpen();
    }
    isClose() {
        return !(this.isOpen());
    }
    addConnection(socket) {
        this.connections.push(new Connection(socket));

        if (!_.isEmpty(this.state)) {
            // Send TinyG2 state to a newly connected client
            socket.emit('Grbl:state', this.state);
        }

        if (this.sender) {
            // Send sender status to a newly connected client
            socket.emit('sender:status', this.sender.state);
        }
    }
    removeConnection(socket) {
        const index = _.findIndex(this.connections, (c) => {
            return c.socket === socket;
        });
        this.connections.splice(index, 1);
    }
    emitAll(eventName, ...args) {
        this.connections.forEach((c) => {
            c.socket.emit.apply(c.socket, [eventName].concat(args));
        });
    }
    command(socket, cmd, ...args) {
        const handler = {
            'load': () => {
                const [name, gcode, callback = noop] = args;

                const ok = this.sender.load(name, gcode);
                if (!ok) {
                    callback(new Error(`Invalid G-code: name=${name}`));
                    return;
                }

                log.debug(`[Grbl] Load G-code: name="${this.sender.name}", size=${this.sender.gcode.length}, total=${this.sender.total}`);

                this.workflowState = WORKFLOW_STATE_IDLE;
                callback(null, { name: name, gcode: gcode });
            },
            'unload': () => {
                this.workflowState = WORKFLOW_STATE_IDLE;
                this.sender.unload();
            },
            'start': () => {
                this.feeder.clear(); // clear feeder queue

                this.workflowState = WORKFLOW_STATE_RUNNING;
                this.sender.rewind(); // rewind sender queue
                this.sender.next();
            },
            'stop': () => {
                const activeState = _.get(this.state, 'status.activeState', '');

                this.workflowState = WORKFLOW_STATE_IDLE;
                this.sender.rewind(); // rewind sender queue

                // Grbl
                if (this.firmware === GRBL) {
                    let delay = 0;

                    if (activeState === GRBL_ACTIVE_STATE_RUN) {
                        this.write(socket, '!'); // hold
                        delay = 50; // 50ms delay
                    }

                    setTimeout(() => {
                        this.write(socket, '\x18'); // ctrl-x
                    }, delay);
                }

                // Smoothie
                if (this.firmware === SMOOTHIE) {
                    let delay = 0;

                    if (activeState === SMOOTHIE_ACTIVE_STATE_HOLD) {
                        this.write(socket, '~'); // resume
                        delay = 50; // 50ms delay
                    }

                    setTimeout(() => {
                        this.write(socket, '\x18'); // ctrl-x
                    }, delay);
                }
            },
            'pause': () => {
                if (this.workflowState === WORKFLOW_STATE_RUNNING) {
                    this.workflowState = WORKFLOW_STATE_PAUSED;
                }

                this.write(socket, '!');
            },
            'resume': () => {
                this.write(socket, '~');

                if (this.workflowState === WORKFLOW_STATE_PAUSED) {
                    this.workflowState = WORKFLOW_STATE_RUNNING;
                    this.sender.next();
                }
            },
            'feedhold': () => {
                if (this.workflowState === WORKFLOW_STATE_RUNNING) {
                    this.workflowState = WORKFLOW_STATE_PAUSED;
                }

                this.write(socket, '!');
            },
            'cyclestart': () => {
                this.write(socket, '~');

                if (this.workflowState === WORKFLOW_STATE_PAUSED) {
                    this.workflowState = WORKFLOW_STATE_RUNNING;
                    this.sender.next();
                }
            },
            'reset': () => {
                if (this.workflowState !== WORKFLOW_STATE_IDLE) {
                    this.workflowState = WORKFLOW_STATE_IDLE;
                    this.sender.rewind(); // rewind sender queue
                }

                this.write(socket, '\x18'); // ^x
            },
            'unlock': () => {
                this.writeln(socket, '$X');
            },
            'homing': () => {
                this.writeln(socket, '$H');
            },
            'check': () => {
                this.writeln(socket, '$C');
            },
            'gcode': () => {
                const line = args.join(' ');

                this.feeder.feed({
                    socket: socket,
                    line: line
                });

                if (!this.feeder.isPending()) {
                    this.feeder.next();
                }
            },
            'loadmacro': () => {
                const [id, callback = noop] = args;
                const macros = config.get('macros');
                const macro = _.find(macros, { id: id });

                if (!macro) {
                    log.error(`[Grbl] Cannot find the macro: id=${id}`);
                    return;
                }

                this.command(null, 'load', macro.name, macro.content, callback);
            },
            'loadfile': () => {
                const [file, callback = noop] = args;

                monitor.readFile(file, (err, data) => {
                    if (err) {
                        callback(err);
                        return;
                    }

                    this.command(null, 'load', file, data, callback);
                });
            }
        }[cmd];

        if (!handler) {
            log.error(`[Grbl] Unknown command: ${cmd}`);
            return;
        }

        handler();
    }
    write(socket, data) {
        if (socket) {
            socket.emit('serialport:write', data);
            const index = _.findIndex(this.connections, (c) => {
                return c.socket === socket;
            });
            if (index >= 0) {
                this.connections[index].sentCommand = data;
            }
        }
        this.serialport.write(data);
        dbg(`[Grbl] > ${data}`);
    }
    writeln(socket, data) {
        if (_.includes(GRBL_REALTIME_COMMANDS, data)) {
            this.write(socket, data);
        } else {
            this.write(socket, data + '\n');
        }
    }
}

export default GrblController;
