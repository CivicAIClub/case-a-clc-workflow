"""
Transforms raw Canvas assignment data into a normalized, grouped schedule.

This module contains only pure functions — no I/O, no side effects.
All date/time conversion happens here using python-dateutil.

Output shape per normalized assignment:
{
  "day":            "Monday",
  "assignment":     "Hamlet Essay Draft",
  "course":         "AP English Literature",
  "due_time":       "11:59 PM",
  "priority":       "Due Soon",
  "days_until_due": 2,
  "due_date":       "2026-04-10",
  "week_start":     "2026-04-06",
  "url":            "https://school.instructure.com/courses/.../assignments/..."
}
"""

# WHAT THIS FILE IS: the "sorting table" of AutoPlanner.
# It takes the messy, detailed assignment list that canvas_api.py pulled from Canvas and turns
# it into a tidy planner: which assignments are due, on what day and time, how urgent they are,
# grouped first by week (Monday to Sunday) and then by day of the week.
# It never talks to Canvas or Google itself; it only rearranges the information it is handed.
# main.py calls build_weekly_schedule() at the bottom of this file. The result goes back to the
# web page to preview, and later to google_docs.py and Apps Script to be written into the Doc.
#
# Bring in date-and-time tools. "tz" (from the dateutil add-on) understands time zones,
# such as "America/New_York", including the switch to and from daylight saving time.
from datetime import date, datetime, timedelta
from typing import Any, Optional

from dateutil import tz


# The days of the week in planner order. Python numbers the days Monday = 0 through Sunday = 6,
# so this list turns a day number into its name.
WEEKDAY_NAMES = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
]


# Turn "how many days until this is due" into a short urgency label for the planner.
# It is given a number of days and gives back a label:
# due today = "Today", 1 day = "Tomorrow", 2 to 3 days = "Due Soon",
# 4 to 7 days = "This Week", and anything later = "Upcoming".
def _compute_priority(days: int) -> str:
    """Map days-until-due to a human-readable priority label."""
    if days == 0:
        return "Today"
    if days == 1:
        return "Tomorrow"
    if days <= 3:
        return "Due Soon"
    if days <= 7:
        return "This Week"
    return "Upcoming"


# Given any date, find the Monday of that same week (by stepping back 0 to 6 days).
# Every assignment is labeled with its week's Monday so assignments can be grouped by week.
def _week_start(d: date) -> date:
    """Return the Monday of the week containing date d."""
    return d - timedelta(days=d.weekday())


# Clean up one assignment from Canvas.
# It is given the raw Canvas assignment, the name of its class, and the school's time zone.
# It gives back a short, tidy summary (day, name, class, due time, urgency, due date, the
# Monday of its week, and its Canvas link), or nothing at all if the assignment should be
# left off the planner.
def normalize_assignment(
    raw: dict[str, Any],
    course_name: str,
    timezone_name: str = "America/New_York",
) -> Optional[dict[str, Any]]:
    """Convert a raw Canvas assignment dict into a normalized shape.

    Returns None if:
    - The assignment has no due_at (no due date set in Canvas)
    - The assignment is already past due

    Canvas always returns due_at in UTC ISO-8601 format.
    We convert to the configured local timezone for display.
    """
    # Some assignments have no due date in Canvas. They can't go on a day-by-day planner,
    # so skip them.
    due_at_str: Optional[str] = raw.get("due_at")
    if not due_at_str:
        return None

    # Canvas gives due dates in world standard time (UTC, marked with a "Z" at the end).
    # Convert that into the school's own time zone, so an assignment due at 11:59 PM in
    # Connecticut doesn't show up as due at 3:59 AM the next day.
    local_tz = tz.gettz(timezone_name)
    due_utc = datetime.fromisoformat(due_at_str.replace("Z", "+00:00"))
    due_local = due_utc.astimezone(local_tz)

    # Work out today's date in the school's time zone, and how many days from today
    # the assignment is due (0 = today, 1 = tomorrow, and so on).
    today = datetime.now(local_tz).date()
    days_until = (due_local.date() - today).days

    # Skip assignments already past due
    # (Anything due earlier today still counts as "today" and stays on the planner.)
    if days_until < 0:
        return None

    # strftime("%-I") strips the leading zero on macOS/Linux (e.g. "9:00 PM" not "09:00 PM")
    # Cross-platform alternative: strftime("%I:%M %p").lstrip("0")
    # Note: the "%-I" form does not work on Windows computers, so the server must run on
    # macOS or Linux.
    due_time_str = due_local.strftime("%-I:%M %p")

    # Put together the tidy summary. The day name comes from the due date's weekday number.
    # If Canvas gave no assignment name, use "Untitled Assignment". The "url" is the link to
    # the assignment in Canvas; the Google Doc also uses it to recognize the same assignment
    # on later runs, so the teacher's Status and Notes stay attached to the right row.
    return {
        "day": WEEKDAY_NAMES[due_local.weekday()],
        "assignment": raw.get("name", "Untitled Assignment"),
        "course": course_name,
        "due_time": due_time_str,
        "priority": _compute_priority(days_until),
        "days_until_due": days_until,
        "due_date": due_local.date().isoformat(),
        "week_start": _week_start(due_local.date()).isoformat(),
        "url": raw.get("html_url", ""),
    }


# Keep only the assignments that fall inside the weeks the staff member asked for.
# It is given the tidied assignments, how many weeks to show, and the school's time zone.
# It gives back just the assignments due between today and the last Sunday of that window.
# Example: asked for 2 weeks on a Wednesday, it keeps work due from today through the
# Sunday of next week.
def filter_assignments_in_calendar_weeks(
    assignments: list[dict[str, Any]],
    weeks_ahead: int,
    timezone_name: str,
) -> list[dict[str, Any]]:
    """Keep assignments due from today through Sunday of the Nth calendar week.

    Weeks start on Monday (aligned with ``week_start`` grouping). For example,
    with ``weeks_ahead=1`` only assignments due through this week's Sunday pass.
    """
    # Find today (in the school's time zone), this week's Monday, and the final Sunday
    # to include: this Monday plus the requested number of weeks, minus one day.
    local_tz = tz.gettz(timezone_name)
    today = datetime.now(local_tz).date()
    monday_this_week = today - timedelta(days=today.weekday())
    last_included_sunday = monday_this_week + timedelta(days=weeks_ahead * 7 - 1)

    # Go through each assignment: skip anything due before today, and keep anything
    # due on or before that final Sunday. Anything later is left out.
    kept: list[dict[str, Any]] = []
    for a in assignments:
        due = date.fromisoformat(a["due_date"])
        if due < today:
            continue
        if due <= last_included_sunday:
            kept.append(a)
    return kept


# Sort assignments into weeks.
# It is given a list of tidied assignments and gives back a set of groups, one per week,
# each labeled with that week's Monday date (for example "2026-04-06").
def group_by_week(
    assignments: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """Group assignments by week, keyed by the Monday ISO date string.

    Example key: "2026-04-06"
    Assignments within each week are sorted by due_date ascending.
    """
    # Go through the assignments from earliest due date to latest, and drop each one into its
    # week's group, starting a new group the first time a week appears. Because the list is
    # sorted first, the weeks come out in order and each week's work is earliest first.
    grouped: dict[str, list] = {}
    for a in sorted(assignments, key=lambda x: x["due_date"]):
        grouped.setdefault(a["week_start"], []).append(a)
    return grouped


# Sort one week's assignments into the seven days of the week.
# It is given the assignments for a single week and gives back a Monday-to-Sunday list,
# where each day holds the assignments due that day.
def group_by_weekday(
    assignments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return a Mon–Sun list with assignments grouped under each day.

    Each entry: {"day": "Monday", "assignments": [...sorted by due time...]}
    Days with no assignments still appear with an empty list so the
    Apps Script always renders a complete Mon–Sun week.
    """
    # Start with seven empty boxes, one for each day of the week.
    buckets: dict[str, list] = {day: [] for day in WEEKDAY_NAMES}

    # Put each assignment into the box for the day it is due.
    for a in assignments:
        if a["day"] in buckets:
            buckets[a["day"]].append(a)

    # Sort each day's assignments: earliest due first, then alphabetically
    # Note: every assignment in one day's box has the same "days until due" number, so in
    # practice this puts each day's assignments in alphabetical order by name, not by time.
    for day in WEEKDAY_NAMES:
        buckets[day].sort(key=lambda x: (x["days_until_due"], x["assignment"]))

    # Give back the seven days in order, Monday first, each with its list of assignments.
    return [{"day": day, "assignments": buckets[day]} for day in WEEKDAY_NAMES]


# The full sorting process, start to finish. main.py calls this one.
# It is given the list of (Canvas assignment, class name) pairs from canvas_api.py, the
# school's time zone, and how many weeks to show. It gives back the finished planner:
# each week in the window that has work due, with a label like "Apr 6 – Apr 12" and its
# seven days of assignments, plus the total number of assignments and the date and time it was made.
def build_weekly_schedule(
    raw_pairs: list[tuple[dict[str, Any], str]],
    timezone_name: str = "America/New_York",
    weeks_ahead: int = 2,
) -> dict[str, Any]:
    """Full pipeline: raw Canvas tuples → structured weekly schedule.

    Args:
        raw_pairs:      list of (canvas_assignment_dict, course_name)
        timezone_name:  IANA timezone string (from .env TIMEZONE)
        weeks_ahead:    how many weeks forward to include

    Returns:
    {
      "weeks": { ... },
      "total_assignments": 14,
      "generated_at": "2026-04-06T12:00:00"
    }

    (``main.py`` also adds ``student_full_name`` from Canvas ``/users/self/profile``.)
    """
    # Step 1: Normalize all raw Canvas assignments
    # (Tidy up each assignment and keep only those with a due date that hasn't passed.)
    normalized = []
    for raw, course_name in raw_pairs:
        result = normalize_assignment(raw, course_name, timezone_name)
        if result is not None:
            normalized.append(result)

    # Step 2: Filter to the requested window
    upcoming = filter_assignments_in_calendar_weeks(
        normalized, weeks_ahead, timezone_name
    )

    # Step 3: Group by week
    by_week = group_by_week(upcoming)

    # Step 4: Build the output structure
    # Only weeks that have at least one assignment appear; an empty week gets no entry.
    weeks_output: dict[str, Any] = {}
    for week_start_str, week_assignments in by_week.items():
        # Work out the week's Monday and its Sunday (six days later).
        week_start_date = date.fromisoformat(week_start_str)
        week_end_date = week_start_date + timedelta(days=6)

        # Human-readable label: "Apr 6 – Apr 12"
        label = (
            f"{week_start_date.strftime('%b %-d')} – "
            f"{week_end_date.strftime('%b %-d')}"
        )

        # Save this week's label and its Monday-to-Sunday list of days.
        weeks_output[week_start_str] = {
            "week_label": label,
            "days": group_by_weekday(week_assignments),
        }

    # Hand back the finished planner, the total number of assignments in it, and a timestamp
    # of when it was built. (That timestamp uses the server computer's own clock and time
    # zone, not the school time zone setting.)
    return {
        "weeks": weeks_output,
        "total_assignments": len(upcoming),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
