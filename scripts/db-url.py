"""Tidy a Supabase connection string pasted into a GitHub secret, for the Database and Nightly backup
workflows. Reads it from the DB_URL environment variable, prints the cleaned string on stdout, and
explains what it fixed (or why it can't be used) on stderr, never showing the password.

Fixes the usual copy-and-paste slips: spaces, line breaks and quote marks around it, a `psql` in
front, the square brackets of `[YOUR-PASSWORD]` left in, and symbols in the password (encoded so
the link stays valid). Exits 1 when what's left still isn't a postgres:// link.

    DB_URL="$SECRET" python3 scripts/db-url.py
"""

import os
import re
import sys
from urllib.parse import quote, unquote


def note(msg: str) -> None:
    print(f"::notice::Connection string: {msg}", file=sys.stderr)


def fail(msg: str) -> None:
    print(f"::error::Connection string: {msg} Copy it again from Supabase → Connect → Session pooler (see the top of .github/workflows/database.yml).", file=sys.stderr)
    sys.exit(1)


raw = os.environ.get("DB_URL", "")
url = raw.strip().strip("'\"`").strip()
if url != raw:
    note("removed spaces, line breaks or quote marks around it.")
prefix = re.match(r"^[A-Za-z_][A-Za-z0-9_]*\s*=\s*", url)
if prefix and "://" in url[prefix.end():]:
    url = url[prefix.end():].strip().strip("'\"")
    note('removed a "NAME=" in front of it.')
if url.lower().startswith("jdbc:"):
    url = url[5:]
    note('removed "jdbc:" in front of it.')
if re.match(r"^psql\s+", url):
    url = re.sub(r"^psql\s+", "", url).strip().strip("'\"")
    note('removed "psql" in front of it.')
if re.search(r"(^|\s)(host|user|dbname|port)=", url):
    fail("it is the list of connection parameters (host=… port=…), not the one-line connection string.")
if re.search(r"\s", url):
    fail("it has a space or line break inside it.")
if "[YOUR-PASSWORD]" in url.upper():
    fail("it still says [YOUR-PASSWORD]; put the database password in its place.")

m = re.match(r"^(postgres(?:ql)?)://([^:/@]+):(.*)@([^@/]+)(/.*)?$", url)
if not m:
    if url.startswith(("http://", "https://")):
        fail("it is a web address (https://…), not the database connection string (postgresql://…).")
    if "://" not in url and "@" not in url:
        fail("it looks like a single word (perhaps only the password), not the whole connection string.")
    if not url.startswith(("postgres://", "postgresql://")):
        fail("it doesn't start with postgresql://.")
    fail("it isn't in the form postgresql://user:password@host:port/postgres.")
scheme, user, password, host, rest = m.groups()

if password.startswith("[") and password.endswith("]"):
    password = password[1:-1]
    note("removed the square brackets around the password.")
if not password:
    fail("the password part is empty.")
encoded = quote(unquote(password), safe="")
if encoded != password:
    note("the password has symbols; encoded them so the link works.")
if ":" not in host:
    note("no port in it; the Session pooler uses 5432.")
elif host.endswith(":6543"):
    note("port 6543 is the Transaction pooler; the Session pooler (5432) is the one to use.")

print(f"{scheme}://{user}:{encoded}@{host}{rest or '/postgres'}")
