#ifndef ESTIMATE_VIEW_H
#define ESTIMATE_VIEW_H

// Temporary score-estimate overlay: snapshot of the current position with
// dead stones marked, territory tinted per owner, and the numeric estimate.
// Opened from the menu; BACK closes it and invokes the on_close callback
// (used by the game to resume a paused AI).
void estimate_view_show(void (*on_close)(void));
void estimate_view_hide(void);

#endif
