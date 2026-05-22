import tkinter as tk
from tkinter import filedialog
import sys
import os

target = sys.argv[1] if len(sys.argv) > 1 else 'model'
initialdir = sys.argv[2] if len(sys.argv) > 2 else None
title = f"Select {target.upper()} model file (.pbip)"

# Validate initialdir exists, force chdir to override cached location
if initialdir and os.path.isdir(initialdir):
    os.chdir(initialdir)
else:
    initialdir = None

root = tk.Tk()
root.withdraw()
root.attributes("-topmost", True)

kwargs = {
    "title": title,
    "filetypes": [("Power BI Project", "*.pbip"), ("All files", "*.*")]
}
if initialdir:
    kwargs["initialdir"] = initialdir

path = filedialog.askopenfilename(**kwargs)

root.destroy()

if path:
    print(path)
    sys.exit(0)
else:
    sys.exit(1)
