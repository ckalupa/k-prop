# Plays board loading fix v3

- Replaced the initial joined board query with a minimal boards query.
- Loads prop counts separately so a count/join failure cannot block board selection.
- Catches selected-board failures instead of returning a page-wide 500.
- Surfaces the underlying API error message in the Plays page.
- Keeps slip history, summary, and bankroll failures isolated.
