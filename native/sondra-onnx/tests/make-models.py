"""Two tiny models for the tests of sondra-onnx, in the two shapes the runner knows (see `onnx.ts` of the website):

  waveform.onnx  [1, 2, 4096] -> [1, 4, 2, 4096]   every stem is the input scaled by 0.1, 0.2, 0.3, 0.4
  mask.onnx      [1, 2, B, F] -> [1, 4, 2, B, F]   one constant mask for each stem: 0.1, 0.2, 0.3, 0.4

Made once with `pip install onnx numpy` and committed; the tests never run Python.
"""
import numpy as np
import onnx
from onnx import TensorProto, helper

scales = np.array([0.1, 0.2, 0.3, 0.4], dtype=np.float32)


def save(graph, name):
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, name)


# Waveform: Unsqueeze the input to [1,1,2,N], multiply by [1,4,1,1].
x = helper.make_tensor_value_info("mix", TensorProto.FLOAT, [1, 2, 4096])
y = helper.make_tensor_value_info("stems", TensorProto.FLOAT, [1, 4, 2, 4096])
axes = helper.make_tensor("axes", TensorProto.INT64, [1], [1])
k = helper.make_tensor("k", TensorProto.FLOAT, [1, 4, 1, 1], scales.tolist())
save(
    helper.make_graph(
        [helper.make_node("Unsqueeze", ["mix", "axes"], ["wide"]), helper.make_node("Mul", ["wide", "k"], ["stems"])],
        "waveform", [x], [y], [axes, k],
    ),
    "models/waveform.onnx",
)

# Mask: input [1,2,B,F] with dynamic B and F; Unsqueeze to [1,1,2,B,F], zero it, add [1,4,1,1,1].
x = helper.make_tensor_value_info("magnitude", TensorProto.FLOAT, [1, 2, "bins", "frames"])
y = helper.make_tensor_value_info("masks", TensorProto.FLOAT, [1, 4, 2, "bins", "frames"])
k = helper.make_tensor("k", TensorProto.FLOAT, [1, 4, 1, 1, 1], scales.tolist())
zero = helper.make_tensor("zero", TensorProto.FLOAT, [1], [0.0])
save(
    helper.make_graph(
        [
            helper.make_node("Unsqueeze", ["magnitude", "axes"], ["wide"]),
            helper.make_node("Mul", ["wide", "zero"], ["nothing"]),
            helper.make_node("Add", ["nothing", "k"], ["masks"]),
        ],
        "mask", [x], [y], [axes, k, zero],
    ),
    "models/mask.onnx",
)
