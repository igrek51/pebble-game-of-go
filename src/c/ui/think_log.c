#include "think_log.h"
#include <pebble.h>
#include <stdio.h>

#define THINK_LOG_CAP 40

static char s_lines[THINK_LOG_CAP][24];
static int s_count = 0;

static void push_line(const char *line) {
    if (s_count < THINK_LOG_CAP) {
        snprintf(s_lines[s_count], sizeof(s_lines[0]), "%s", line);
        s_count++;
    } else {
        // Keep the original opening for reference, replace the latest turn.
        snprintf(s_lines[THINK_LOG_CAP - 1], sizeof(s_lines[0]), "%s", line);
    }
}

void think_log_push_computer(const char *color, int secs) {
    char buf[24];
    snprintf(buf, sizeof(buf), "%s AI   %ds", color, secs);
    push_line(buf);
}

void think_log_push_human(const char *color, int secs) {
    char buf[24];
    snprintf(buf, sizeof(buf), "%s hum  %ds", color, secs);
    push_line(buf);
}

int think_log_count(void) { return s_count; }

const char *think_log_at(int index) {
    if (index < 0 || index >= s_count)
        return NULL;
    return s_lines[index];
}
