#ifndef THINK_LOG_H
#define THINK_LOG_H

void think_log_push_computer(const char *color, int secs);
void think_log_push_human(const char *color, int secs);

int think_log_count(void);
const char *think_log_at(int index);

#endif
