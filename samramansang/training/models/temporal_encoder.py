import math
from typing import List, Tuple, Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


class TemporalBlock(nn.Module):
    """
    Temporal Conv block over (C*J, T).
    Input: (B, C*J, T)
    - Conv1d with dilation
    - Norm + SiLU
    - Residual projection if channel dims mismatch
    """

    def __init__(self, in_channels: int, out_channels: int, kernel_size: int = 5, dilation: int = 1):
        super().__init__()
        padding = (kernel_size - 1) // 2 * dilation
        self.conv = nn.Conv1d(in_channels, out_channels, kernel_size=kernel_size,
                               padding=padding, dilation=dilation)
        self.norm = nn.BatchNorm1d(out_channels)
        self.act = nn.SiLU(inplace=True)
        self.proj = None
        if in_channels != out_channels:
            self.proj = nn.Conv1d(in_channels, out_channels, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        identity = x
        x = self.conv(x)
        x = self.norm(x)
        x = self.act(x)
        if self.proj is not None:
            identity = self.proj(identity)
        return x + identity


class JointMixer(nn.Module):
    """
    Lightweight joint mixing across J by 1x1 conv along the (C, J) channel layout.
    Implements a linear mixing over joints at each time step.
    Strategy: reshape (B, C, J, T) -> (B, C*T, J), Conv1d over J, reshape back.
    """

    def __init__(self, num_channels: int, num_joints: int):
        super().__init__()
        self.num_channels = num_channels
        self.num_joints = num_joints
        self.mixer = nn.Conv1d(num_joints, num_joints, kernel_size=1, groups=1, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, C, J, T)
        b, c, j, t = x.shape
        x_perm = x.permute(0, 3, 1, 2).contiguous().view(b, t * c, j)  # (B, T*C, J)
        x_perm = x_perm.transpose(1, 2)  # (B, J, T*C)
        x_mix = self.mixer(x_perm)  # (B, J, T*C)
        x_mix = x_mix.transpose(1, 2).contiguous().view(b, t, c, j).permute(0, 2, 3, 1).contiguous()
        return x_mix


class TemporalEncoder(nn.Module):
    """
    Lightweight temporal encoder for pose windows.

    Input:  (B, C, J, T) where typically C=3 (x,y,score), J=17
    Output: (B, D) embedding
    """

    def __init__(
        self,
        in_channels: int = 3,
        num_joints: int = 17,
        hidden_dim: int = 128,
        num_blocks: int = 4,
        kernel_size: int = 5,
        dilations: Optional[List[int]] = None,
        use_joint_mixer: bool = True,
        emb_dim: int = 128,
    ):
        super().__init__()
        self.in_channels = in_channels
        self.num_joints = num_joints
        self.hidden_dim = hidden_dim
        self.emb_dim = emb_dim

        cjt = in_channels * num_joints
        if dilations is None:
            dilations = [1, 2, 4, 8][:num_blocks]

        blocks: List[nn.Module] = []
        ch_in = cjt
        for d in dilations:
            blocks.append(TemporalBlock(ch_in, hidden_dim, kernel_size=kernel_size, dilation=d))
            ch_in = hidden_dim
        self.tcn = nn.Sequential(*blocks)

        self.use_joint_mixer = use_joint_mixer
        if use_joint_mixer:
            self.joint_mixer = JointMixer(in_channels, num_joints)
            self.post_proj = nn.Conv1d(hidden_dim, hidden_dim, kernel_size=1)

        self.head = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.BatchNorm1d(hidden_dim),
            nn.SiLU(inplace=True),
            nn.Linear(hidden_dim, emb_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, C, J, T)
        if self.use_joint_mixer:
            x = self.joint_mixer(x)  # (B, C, J, T)
        b, c, j, t = x.shape
        x = x.view(b, c * j, t)  # (B, C*J, T)
        x = self.tcn(x)          # (B, hidden, T)
        x = x.mean(dim=-1)       # GAP over time -> (B, hidden)
        x = self.head(x)         # (B, emb_dim)
        return x


class ProjectionHead(nn.Module):
    """2-layer MLP projection head for SimCLR (NT-Xent)."""

    def __init__(self, in_dim: int = 128, hidden_dim: int = 256, out_dim: int = 128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(in_dim, hidden_dim),
            nn.BatchNorm1d(hidden_dim),
            nn.SiLU(inplace=True),
            nn.Linear(hidden_dim, out_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.net(x)
        z = F.normalize(z, dim=-1)
        return z


class MotionEncoder(nn.Module):
    """
    Convenience wrapper that returns both feature and projection for SimCLR.
    """

    def __init__(
        self,
        in_channels: int = 3,
        num_joints: int = 17,
        hidden_dim: int = 128,
        emb_dim: int = 128,
        proj_hidden: int = 256,
        proj_out: int = 128,
    ):
        super().__init__()
        self.encoder = TemporalEncoder(
            in_channels=in_channels,
            num_joints=num_joints,
            hidden_dim=hidden_dim,
            emb_dim=emb_dim,
        )
        self.proj = ProjectionHead(in_dim=emb_dim, hidden_dim=proj_hidden, out_dim=proj_out)

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        feat = self.encoder(x)
        z = self.proj(feat)
        return feat, z


