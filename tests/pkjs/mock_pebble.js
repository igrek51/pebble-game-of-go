/*
 * Mock global `Pebble` for running the companion pkjs under Node.
 * Mirrors timely-plus sidecar/test/pkjs/mock_pebble.js: captures outbound
 * messages and can fire `appmessage` events.
 */
'use strict';

class PebbleMock {
    constructor() {
        this.listeners = {};
        this.sentMessages = [];
        this.failSend = false;
    }

    addEventListener(event, callback) {
        (this.listeners[event] = this.listeners[event] || []).push(callback);
    }

    _emit(event, payload) {
        if (this.listeners[event]) {
            this.listeners[event].forEach((cb) => cb(payload));
        }
    }

    sendAppMessage(payload, ack, nack) {
        this.sentMessages.push(JSON.parse(JSON.stringify(payload)));
        if (this.failSend) {
            if (nack) nack();
        } else {
            if (ack) ack();
        }
    }

    reset() {
        this.sentMessages = [];
        this.failSend = false;
    }
}

function freshPebble() {
    const instance = new PebbleMock();
    global.Pebble = instance;
    return instance;
}

module.exports = { freshPebble };
