#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The desktop tool rewords the shared radio check's notes for a live test, which has no logs and takes a layout
rather than positions. Held to the notes radio_check.py actually writes, so that a change of wording there, such as
"device" becoming "tag", cannot quietly leave the web tool's words on this tool's screen again.

   python3 test_radio_wording.py
"""

import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import radio_check
import tottag


class RadioWording(unittest.TestCase):

   def test_the_notes_a_live_test_can_get_are_reworded_for_this_tool(self):
      result = radio_check.analyse_radio([{'uid': 1, 'label': 'A', 'summary': None}, {'uid': 2, 'label': 'B', 'summary': None}])
      notes = [tottag.radio_wording(note) for note in result['notes']]
      self.assertIn('2 of the 2 TotTags in the test sent no data, so they are not judged and their links are missing from the others.', notes)
      self.assertIn('No layout chosen, so distances are checked for consistency only. Choose the circle or line the TotTags sit in to '
                    'check accuracy as well.', notes)

   def test_distances_are_given_in_inches(self):
      self.assertEqual(tottag.radio_wording('Reads about 179 mm long on every link.'), 'Reads about 7.0 in long on every link.')
      self.assertEqual(tottag.radio_wording('A and B measured about 30 cm apart. Place every tag at least 2 feet (60 cm) from every other.'),
                       'A and B measured about 12 in apart. Place every tag at least 2 feet (60 cm) from every other.')


if __name__ == '__main__':
   unittest.main()
