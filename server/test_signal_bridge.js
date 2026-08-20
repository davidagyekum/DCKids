// Windows does not deliver SIGTERM to a child Node process like POSIX does.
// This test-only preload turns IPC signal requests into process signal events
// and emulates the default fatal action when no listener remains.
process.on('message', (message) => {
    if (!message || !message.signal) return;
    if (!process.emit(message.signal)) process.exit(128 + 15);
});
