# status: complete

from typing import Dict, Any, Callable, Optional, List
from dataclasses import dataclass
from datetime import datetime
from utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class FunctionSchema:
    """Schema definition for function parameters."""
    type: str
    description: Optional[str] = None
    required: bool = False
    default: Optional[Any] = None


@dataclass
class FunctionMetadata:
    """Metadata for a registered function."""
    name: str
    description: str
    input_schema: Dict[str, FunctionSchema]
    output_schema: Optional[FunctionSchema] = None
    category: str = "general"
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert metadata to dictionary."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": {k: {"type": v.type, "description": v.description, "required": v.required, "default": v.default} 
                           for k, v in self.input_schema.items()},
            "output_schema": {"type": self.output_schema.type, "description": self.output_schema.description} 
                           if self.output_schema else None,
            "category": self.category
        }


@dataclass
class FunctionExecutionResult:
    """Result of function execution."""
    success: bool
    result: Any = None
    error: Optional[str] = None
    execution_time_ms: Optional[float] = None
    function_name: Optional[str] = None


class FunctionInterface:
    """MCP-like function interface for registering and executing functions."""
    
    def __init__(self):
        self._functions: Dict[str, Callable] = {}
        self._metadata: Dict[str, FunctionMetadata] = {}
        self._categories: Dict[str, List[str]] = {}
        logger.info("FunctionInterface initialized")
    
    def register_function(self, name: str, function: Callable, description: str, 
                        input_schema: Dict[str, FunctionSchema], output_schema: Optional[FunctionSchema] = None,
                        category: str = "general", override: bool = False) -> bool:
        """Register a function with metadata."""
        if name in self._functions and not override:
            logger.warning(f"Function '{name}' already exists")
            return False
        
        try:
            metadata = FunctionMetadata(name, description, input_schema, output_schema, category)
            self._functions[name] = function
            self._metadata[name] = metadata
            
            if category not in self._categories:
                self._categories[category] = []
            if name not in self._categories[category]:
                self._categories[category].append(name)
            
            logger.info(f"Registered '{name}' in '{category}'")
            return True
        except Exception as e:
            logger.error(f"Failed to register '{name}': {e}")
            return False
    
    def unregister_function(self, name: str) -> bool:
        """Remove a function."""
        if name not in self._functions:
            return False
        
        metadata = self._metadata[name]
        del self._functions[name]
        del self._metadata[name]
        
        if metadata.category in self._categories:
            self._categories[metadata.category].remove(name)
            if not self._categories[metadata.category]:
                del self._categories[metadata.category]
        
        return True
    
    def get_available_functions(self, category: Optional[str] = None) -> List[str]:
        """Get function names, optionally filtered by category."""
        return self._categories.get(category, []) if category else list(self._functions.keys())
    
    def get_function_metadata(self, name: str) -> Optional[Dict[str, Any]]:
        """Get metadata for a function."""
        return self._metadata[name].to_dict() if name in self._metadata else None
    
    def get_all_metadata(self) -> Dict[str, Dict[str, Any]]:
        """Get all function metadata."""
        return {name: metadata.to_dict() for name, metadata in self._metadata.items()}
    
    def get_categories(self) -> Dict[str, List[str]]:
        """Get all categories and their functions."""
        return self._categories.copy()
    
    def function_exists(self, name: str) -> bool:
        """Check if function exists."""
        return name in self._functions
    
    def validate_input(self, name: str, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """Validate function inputs."""
        if name not in self._metadata:
            return {"valid": False, "errors": [f"Function '{name}' not found"]}
        
        errors = []
        metadata = self._metadata[name]
        
        for param_name, schema in metadata.input_schema.items():
            if schema.required and param_name not in inputs:
                errors.append(f"Required parameter '{param_name}' missing")
        
        for param_name, value in inputs.items():
            if param_name not in metadata.input_schema:
                errors.append(f"Unknown parameter '{param_name}'")
            elif not self._validate_type(value, metadata.input_schema[param_name]):
                errors.append(f"Parameter '{param_name}' type mismatch")
        
        return {"valid": len(errors) == 0, "errors": errors}
    
    def _validate_type(self, value: Any, schema: FunctionSchema) -> bool:
        """Validate value against schema type."""
        type_map = {
            "string": str, "integer": int, "number": (int, float),
            "boolean": bool, "array": list, "object": dict, "null": type(None)
        }
        expected_type = type_map.get(schema.type)
        return expected_type is None or isinstance(value, expected_type)
    
    def execute_function(self, name: str, inputs: Dict[str, Any], validate: bool = True) -> FunctionExecutionResult:
        """Execute a function with validation."""
        start_time = datetime.now()
        
        if name not in self._functions:
            return FunctionExecutionResult(False, error=f"Function '{name}' not found", function_name=name)
        
        if validate:
            validation = self.validate_input(name, inputs)
            if not validation["valid"]:
                return FunctionExecutionResult(False, error=f"Validation failed: {', '.join(validation['errors'])}", function_name=name)
        
        try:
            result = self._functions[name](**inputs)
            execution_time = (datetime.now() - start_time).total_seconds() * 1000
            return FunctionExecutionResult(True, result=result, execution_time_ms=execution_time, function_name=name)
        except Exception as e:
            execution_time = (datetime.now() - start_time).total_seconds() * 1000
            return FunctionExecutionResult(False, error=str(e), execution_time_ms=execution_time, function_name=name)
    
    def get_statistics(self) -> Dict[str, Any]:
        """Get interface statistics."""
        return {
            "total_functions": len(self._functions),
            "categories": len(self._categories),
            "functions_by_category": {cat: len(funcs) for cat, funcs in self._categories.items()}
        }


function_interface = FunctionInterface()


def register_tool(name: str, description: str, input_schema: Dict[str, FunctionSchema], 
                 output_schema: Optional[FunctionSchema] = None, category: str = "general"):
    """Decorator for registering functions as tools."""
    def decorator(func: Callable) -> Callable:
        function_interface.register_function(name, func, description, input_schema, output_schema, category)
        return func
    return decorator