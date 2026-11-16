TotTag Management Dashboard
===========================

Desktop application for configuring TotTag deployments and downloading recorded data.

TotTag is a wearable device that measures how close people are to one another, continuously, with no
infrastructure in the room. Each device ranges against every other device nearby twice a second using an
ultra-wideband radio, recording distances to on-board flash.

Installation
------------

``python3 -m pip install tottag``

Or, from a clone of the `tottag-dashboard repository <https://github.com/hedgetechllc/tottag-dashboard>`_,
in ``Python``:

``python3 -m pip install -e .``

Usage
-----

Run ``tottag`` from any terminal. You do not need to be in the source directory.

Documentation
-------------

Full documentation is at https://lab11.github.io/socitrack/ — covering device setup, scheduling a
deployment, downloading logs, and reading the resulting data. A browser-based equivalent of this tool,
which needs no installation, is at https://app.tottag.net/.
