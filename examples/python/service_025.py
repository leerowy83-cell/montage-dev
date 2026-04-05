# Example project file 25
# This is a sample workspace file demonstrating MontageDev AI capabilities.

import os, sys, json, re, time
from pathlib import Path
from typing import Optional, List, Dict, Any, Union

class ExampleService25:
    def __init__(self, config: dict):
        self.config = config
        self.initialized = False
        
    def process(self, data: List[Dict]) -> Dict[str, Any]:
        results = []
        for item in data:
            processed = self._transform(item)
            if self._validate(processed):
                results.append(processed)
        return {'processed': len(results), 'results': results}
    
    def _transform(self, item: dict) -> dict:
        return {k: str(v).strip() for k, v in item.items() if v is not None}
    
    def _validate(self, item: dict) -> bool:
        return bool(item.get('id')) and bool(item.get('type'))

# Tests
import unittest

class TestExampleService25(unittest.TestCase):
    def setUp(self):
        self.svc = ExampleService25({})
    
    def test_empty_input(self):
        result = self.svc.process([])
        self.assertEqual(result['processed'], 0)
    
    def test_filters_invalid(self):
        data = [{'id': '1', 'type': 'a'}, {'name': 'only'}]
        result = self.svc.process(data)
        self.assertEqual(result['processed'], 1)
    
    def test_transforms_values(self):
        data = [{'id': ' 123 ', 'type': ' test '}]
        result = self.svc.process(data)
        self.assertEqual(result['results'][0]['id'], '123')

if __name__ == '__main__':
    unittest.main()
