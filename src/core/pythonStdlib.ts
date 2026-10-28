/**
 * Top-level names of the Python standard library (public modules of 3.12, the
 * `sys.stdlib_module_names` set without private `_x` modules). Used only to tell
 * `import logging` (the standard library) from a project file that happens to be
 * called `logging.py`; see `resolvePythonAbsoluteTargets`.
 */
export const PYTHON_STDLIB_MODULES: ReadonlySet<string> = new Set(
  (
    "abc aifc antigravity argparse array ast asyncio atexit audioop base64 bdb binascii bisect " +
    "builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections " +
    "colorsys compileall concurrent configparser contextlib contextvars copy copyreg crypt csv " +
    "ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip " +
    "enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc " +
    "genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http " +
    "idlelib imaplib imghdr importlib inspect io ipaddress itertools json keyword lib2to3 " +
    "linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder " +
    "msilib msvcrt multiprocessing netrc nis nntplib ntpath nturl2path numbers opcode operator " +
    "optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib " +
    "poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data " +
    "pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets " +
    "select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver " +
    "spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep " +
    "struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile " +
    "termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback " +
    "tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv " +
    "warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile " +
    "zipimport zlib zoneinfo"
  ).split(" ")
);
