"""
Canvas LMS REST API client.

Canvas API Reference: https://canvas.instructure.com/doc/api/

Example course object (abbreviated):
{
  "id": 12345,
  "name": "AP English Literature",
  "course_code": "ENG-AP",
  "enrollment_term_id": 7,
  "workflow_state": "available"
}

Example assignment object (abbreviated):
{
  "id": 98765,
  "name": "Hamlet Essay Draft",
  "due_at": "2026-04-10T23:59:00Z",
  "points_possible": 100,
  "submission_types": ["online_upload"],
  "html_url": "https://school.instructure.com/courses/12345/assignments/98765",
  "course_id": 12345
}
"""

# WHAT THIS FILE IS: the part of AutoPlanner that talks to Canvas, the school's online class
# system where teachers post assignments.
# It uses Canvas's API (a set of special web addresses that hand back information in a form
# computer programs can read, instead of a web page meant for people).
# For one student at a time, it asks Canvas: "which classes is this student in right now?",
# then "what assignments does each class have?", and "what is this student's name?".
# Every question is sent with that student's Canvas token (a long secret password the student
# created in Canvas; it lets this tool read their classes as if it were them).
# main.py calls the functions in this file. The raw assignment list it returns then goes to
# processor.py to be cleaned up and sorted into weeks and days.
#
# Bring in the tools this file needs: "re" finds patterns in text, and httpx sends web requests.
import re
from typing import Any, Dict, List, Optional

import httpx


# Build the "ID badge" that goes along with every request to Canvas.
# It is given the student's token and gives back the standard line that says
# "here is my token, please let me in", which Canvas checks before answering.
def _build_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# Canvas never sends a long list all at once; it splits it into "pages" (up to 100 items each
# here). This helper is given a student's token, a Canvas web address, and any extra search
# options. It keeps asking for the next page until there are none left, then gives back one
# complete list with everything from every page.
def _paginate(token: str, url: str, params: Optional[Dict[str, Any]] = None) -> List[dict]:
    """Follow Canvas Link-header pagination and return all results.

    Canvas signals the next page via a Link header:
      Link: <https://...?page=2&per_page=100>; rel="next", ...

    We follow every "next" link until there are no more pages.
    """
    # Get ready: the ID badge, an empty list to collect results in, and the first page's address.
    headers = _build_headers(token)
    results: list[dict] = []
    next_url: Optional[str] = url

    # Open a connection to Canvas. If Canvas takes more than 30 seconds to answer, give up.
    with httpx.Client(timeout=30.0) as client:
        # Keep going as long as there is another page to fetch.
        while next_url:
            # Ask Canvas for this page. If Canvas answers with an error (for example, the token
            # is wrong), stop here; main.py turns that into a message for the web page.
            # Otherwise, add this page's items to the growing list.
            response = client.get(next_url, headers=headers, params=params)
            response.raise_for_status()
            results.extend(response.json())

            # params are already encoded in next_url after the first request
            params = None

            # Canvas tucks the address of the next page into a hidden note on its reply
            # (the "Link" header). Look for the part labeled "next" and pull out its address.
            # If there is no "next" part, this was the last page and the loop ends.
            link_header = response.headers.get("Link", "")
            match = re.search(r'<([^>]+)>;\s*rel="next"', link_header)
            next_url = match.group(1) if match else None

    return results


# Ask Canvas which classes this student is taking right now.
# It is given the student's token and the school's Canvas address, and gives back a list of
# classes (each with its ID number, name, and other details).
def get_active_courses(token: str, base_url: str) -> list[dict[str, Any]]:
    """Return all courses where the caller is an active student.

    Filters out concluded, deleted, and non-student enrollments so we never
    surface assignments from courses the student already finished.
    """
    # Build the question: "list my classes where I am an active student and the class is open,
    # 100 at a time". The rstrip('/') removes a trailing slash from the school's address so
    # we don't end up with a double slash in the middle.
    url = f"{base_url.rstrip('/')}/api/v1/courses"
    params = {
        "enrollment_type": "student",
        "enrollment_state": "active",
        "state[]": "available",
        "per_page": 100,
    }
    # Get every page of classes, then keep only the ones Canvas marks as "available" (open),
    # as a second safety check in case Canvas slipped in any finished or unpublished ones.
    courses = _paginate(token, url, params)
    return [c for c in courses if c.get("workflow_state") == "available"]


# Ask Canvas for every assignment in one class.
# It is given the student's token, the school's Canvas address, and the class's ID number,
# and gives back that class's full list of assignments, sorted by due date.
def get_assignments_for_course(
    token: str, base_url: str, course_id: int
) -> list[dict[str, Any]]:
    """Return published assignments for a single course.

    We intentionally do **not** pass ``bucket=upcoming``: Canvas often applies a
    short horizon (roughly one week), which made \"weeks to fetch\" in AutoPlanner
    ineffective. We fetch published assignments ordered by due date and filter by
    date window in ``processor.py`` instead.
    """
    # Build the question for this one class and collect every page of its assignments.
    # This includes old assignments too; processor.py throws out the ones already past due.
    url = f"{base_url.rstrip('/')}/api/v1/courses/{course_id}/assignments"
    params = {
        "order_by": "due_at",
        "per_page": 100,
    }
    assignments = _paginate(token, url, params)

    # Inject course_id so processor.py can correlate without extra lookups
    # (In plain words: stamp each assignment with the ID of the class it came from.)
    for a in assignments:
        a["_course_id"] = course_id

    return assignments


# The main "gather everything" step that main.py uses.
# It is given the student's token and the school's Canvas address. It finds all the student's
# current classes, then gets every assignment from each class, one class at a time.
# It gives back one long list where each item pairs an assignment with the name of its class.
def get_all_assignments(
    token: str, base_url: str
) -> list[tuple[dict[str, Any], str]]:
    """Aggregate assignments from all active student courses.

    Returns a list of (assignment_dict, course_name) tuples so the processor
    does not need to re-join on course ID. Date filtering happens in
    ``processor.py``.
    """
    courses = get_active_courses(token, base_url)
    all_assignments: list[tuple[dict[str, Any], str]] = []

    # Go through the student's classes one by one. Use the class's name, or "Course" plus its
    # ID number if Canvas gave no name. Fetch that class's assignments and add each one to the
    # big list, paired with the class name so the planner can show which class it belongs to.
    for course in courses:
        course_id = course["id"]
        course_name = course.get("name", f"Course {course_id}")
        assignments = get_assignments_for_course(token, base_url, course_id)
        for assignment in assignments:
            all_assignments.append((assignment, course_name))

    return all_assignments


# Ask Canvas "who owns this token?" to learn the student's name and Canvas ID number.
# It is given the student's token and the school's Canvas address, and gives back the
# student's profile. main.py uses the name to title the Google Doc, and the ID number so the
# web page can find the same student's Doc again next time.
def get_self_profile(token: str, base_url: str) -> dict[str, Any]:
    """Return the Canvas user profile for the API token (student display name, etc.)."""
    # A profile is a single item, not a long list, so no page-by-page fetching is needed.
    # As above: give up after 30 seconds, and stop with an error if Canvas refuses.
    url = f"{base_url.rstrip('/')}/api/v1/users/self/profile"
    with httpx.Client(timeout=30.0) as client:
        response = client.get(url, headers=_build_headers(token))
        response.raise_for_status()
        return response.json()
